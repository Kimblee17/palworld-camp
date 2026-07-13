"""API navigateur exposée au JavaScript via Pyodide.

Points d'entrée :
    parse_save(data: bytes, full=False) -> str (JSON)   # zlib (PlZ/CNK), décompresse en Python
    parse_gvas(raw: bytes, save_type=None, full=False) -> str (JSON)  # GVAS déjà décompressé (Oodle décompressé côté JS)

N'utilise PAS palsav.io (chemins fichier). Appelle directement le pipeline pur-Python.
Les helpers d'extraction sont inlinés ici pour ne PAS dépendre de fonctions
privées de palsav (robustesse face aux mises à jour upstream).
"""

import json
import math
import re

from palsav.core import decompress_sav_to_gvas
from palsav.gvas import GvasFile
from palsav.paltypes import PALWORLD_TYPE_HINTS, PALWORLD_CUSTOM_PROPERTIES
from palsav.json_tools import CustomEncoder


def _sanitize(obj):
    """Remplace NaN/Infinity (invalides en JSON strict / JS) par None."""
    if isinstance(obj, float):
        return None if (math.isnan(obj) or math.isinf(obj)) else obj
    if isinstance(obj, dict):
        return {k: _sanitize(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_sanitize(v) for v in obj]
    return obj


def _val(prop, default=None):
    """Déballe la valeur d'une propriété GVAS ({'value': ...}) de façon défensive."""
    if not isinstance(prop, dict):
        if prop is None:
            return default
        return str(prop) if hasattr(prop, "hex") and hasattr(prop, "version") else prop
    v = prop.get("value")
    if v is None:
        return default
    if isinstance(v, dict):
        return _val(v, v)
    if hasattr(v, "hex") and hasattr(v, "version"):  # UUID
        return str(v)
    return v


def _charmap(world):
    return world.get("CharacterSaveParameterMap", {}).get("value", [])


def _groupmap(world):
    return world.get("GroupSaveDataMap", {}).get("value", [])


def _save_param(entry):
    return (entry.get("value", {}).get("RawData", {}).get("value", {})
            .get("object", {}).get("SaveParameter", {}).get("value", {}))


def _is_player(entry):
    return bool(_val(_save_param(entry).get("IsPlayer"), False))


def _player_uid(entry):
    v = entry.get("key", {}).get("PlayerUId", {}).get("value", "")
    return str(v) if not isinstance(v, str) else v


def _read_gvas(raw):
    return GvasFile.read(
        bytes(raw),
        PALWORLD_TYPE_HINTS,
        PALWORLD_CUSTOM_PROPERTIES,
        allow_nan=True,
    )


def _extract_players(charmap):
    out = []
    for e in charmap:
        if not _is_player(e):
            continue
        sv = _save_param(e)
        out.append({
            "uid": _player_uid(e),
            "name": _val(sv.get("NickName")),
            "level": _val(sv.get("Level")),
        })
    return out


def _extract_guilds(groupmap):
    out = []
    for g in groupmap:
        gv = g.get("value", {}).get("RawData", {}).get("value", {})
        if gv.get("group_type") != "EPalGroupType::Guild":
            continue
        out.append({
            "guild_id": str(g.get("key", "") or ""),
            "name": gv.get("guild_name"),
            "base_ids": [str(b) for b in gv.get("base_ids", [])],
            "players": [
                {"uid": p.get("player_uid", ""),
                 "name": (p.get("player_info", {}) or {}).get("player_name")}
                for p in gv.get("players", [])
            ],
        })
    return out


def _arr_values(prop):
    """Valeurs d'un ArrayProperty : prop.value.values -> list."""
    return list(((prop or {}).get("value", {}) or {}).get("values", []) or [])


def _instance_id(entry):
    v = (entry.get("key", {}).get("InstanceId", {}) or {}).get("value", "")
    return str(v) if v else None


def _extract_pals(charmap):
    out = []
    for e in charmap:
        if _is_player(e):
            continue
        sv = _save_param(e)
        gender = _val(sv.get("Gender"))
        if isinstance(gender, str):
            gender = gender.replace("EPalGenderType::", "")
        rank = _val(sv.get("Rank"), 1) or 1              # 1..5 (absent => 1 = 0 étoile)
        slot = (sv.get("SlotId", {}) or {}).get("value", {})
        container = (((slot.get("ContainerId", {}) or {}).get("value", {})
                      or {}).get("ID", {}) or {}).get("value")
        out.append({
            "instance_id": _instance_id(e),                         # ID unique du Pal
            "species": _val(sv.get("CharacterID")),
            "nickname": _val(sv.get("NickName")),
            "level": _val(sv.get("Level")),
            "gender": gender,
            "owner_uid": str(_val(sv.get("OwnerPlayerUId"), "") or ""),
            "rank": rank,
            "stars": max(0, rank - 1),                              # étoiles = rank - 1
            "souls": {                                             # condensation d'âmes (absent => 0)
                "hp": _val(sv.get("Rank_HP"), 0) or 0,
                "attack": _val(sv.get("Rank_Attack"), 0) or 0,
                "defense": _val(sv.get("Rank_Defence"), 0) or 0,   # note : "Defence" (orthographe du jeu)
                "craft_speed": _val(sv.get("Rank_CraftSpeed"), 0) or 0,
            },
            "ivs": {                                               # talents innés 0..100 (absent => 0)
                "hp": _val(sv.get("Talent_HP"), 0) or 0,
                "shot": _val(sv.get("Talent_Shot"), 0) or 0,
                "defense": _val(sv.get("Talent_Defense"), 0) or 0,
            },
            "passives": _arr_values(sv.get("PassiveSkillList")),   # codes internes des passifs
            "container_id": str(container) if container else None, # conteneur (équipe / boîte / base)
            "slot_index": (slot.get("SlotIndex", {}) or {}).get("value"),
        })
    return out


def _extract_camps(world, pals):
    """Bases (camps) : machines installées + Pals associés + affectations Pal↔machine.

    Sources : BaseCampSaveData (base + conteneur de travailleurs), WorkSaveData
    (une entrée par poste de travail : machine, base, slots, Pals assignés).
    """
    # Pals regroupés par conteneur (pour relier une base à ses Pals).
    by_container = {}
    for p in pals:
        by_container.setdefault(p.get("container_id"), []).append(p.get("instance_id"))

    # Travaux regroupés par base.
    work_by_base = {}
    for w in _values(world.get("WorkSaveData")):
        raw = (w.get("RawData", {}) or {}).get("value", {}) or {}
        base = str(raw.get("base_camp_id_belong_to", "") or "")
        if not base:
            continue
        wtype = ((((w.get("WorkableType", {}) or {}).get("value", {}) or {}).get("value")) or "")
        wtype = wtype.replace("EPalWorkableType::", "")
        station = raw.get("assign_define_data_id") or None
        if station:
            station = re.sub(r"_\d+$", "", station)   # "BlastFurnace_0" -> "BlastFurnace"
        assigned = []
        for a in _val(w.get("WorkAssignMap"), []) or []:
            ar = (((a.get("value", {}) or {}).get("RawData", {}) or {}).get("value", {}) or {})
            iid = (ar.get("assigned_individual_id", {}) or {}).get("instance_id")
            if iid:
                assigned.append({"slot": a.get("key"), "pal_instance_id": str(iid)})
        work_by_base.setdefault(base, []).append({
            "work_id": str(raw.get("id", "") or ""),
            "type": wtype,                                   # Progress, Defense, CollectResource…
            "station": station,                              # id de la machine/poste (ex. BlastFurnace)
            "slots": len(raw.get("assign_locations", []) or []),
            "assigned": assigned,                            # [{slot, pal_instance_id}]
        })

    camps = []
    for i, e in enumerate(world.get("BaseCampSaveData", {}).get("value", []), 1):
        v = e.get("value", {})
        raw = (v.get("RawData", {}) or {}).get("value", {}) or {}
        wc = (((((v.get("WorkerDirector", {}) or {}).get("value", {}) or {})
                .get("RawData", {}) or {}).get("value", {}) or {}).get("container_id"))
        wc = str(wc) if wc else None
        base_id = str(e.get("key", "") or raw.get("id", "") or "")
        loc = (raw.get("transform", {}) or {}).get("translation", {}) or {}
        machines = work_by_base.get(base_id, [])
        pal_ids = by_container.get(wc, [])
        camps.append({
            "base_id": base_id,
            "index": i,
            "guild_id": str(raw.get("group_id_belong_to", "") or ""),
            "location": {"x": loc.get("x"), "y": loc.get("y"), "z": loc.get("z")},
            "worker_container_id": wc,
            "pal_instance_ids": pal_ids,
            "pal_count": len(pal_ids),
            "machines": machines,
            "machine_count": len(machines),
        })
    return camps


def _summarize(dump, save_type=None, full=False):
    world = dump.get("properties", {}).get("worldSaveData", {}).get("value", {})
    charmap = _charmap(world)
    groupmap = _groupmap(world)
    pals = _extract_pals(charmap)
    result = {
        "save_type": save_type,  # 48=CNK, 49=PlM(Oodle), 50=PlZ(zlib)
        "save_game_class_name": dump.get("header", {}).get("save_game_class_name"),
        "counts": {
            "characters": len(charmap),
            "players": sum(1 for e in charmap if _is_player(e)),
            "guilds": sum(
                1 for g in groupmap
                if g.get("value", {}).get("RawData", {}).get("value", {}).get("group_type")
                == "EPalGroupType::Guild"
            ),
        },
        "players": _extract_players(charmap),
        "guilds": _extract_guilds(groupmap),
        "pals": pals,
        "camps": _extract_camps(world, pals),
    }
    if full:
        result["gvas"] = dump
    return json.dumps(_sanitize(result), cls=CustomEncoder, allow_nan=False, ensure_ascii=False)


def parse_gvas(raw, save_type=None, full=False):
    """Parse un GVAS DÉJÀ décompressé (bytes) -> JSON. (Oodle décompressé côté JS.)"""
    return _summarize(_read_gvas(raw).dump(), save_type, full)


def parse_save(data, full=False):
    """Décode une save zlib (PlZ/CNK) depuis des bytes -> JSON. Décompression en Python."""
    raw_gvas, save_type = decompress_sav_to_gvas(bytes(data))
    return _summarize(_read_gvas(raw_gvas).dump(), save_type, full)


# ---- Debug : dump BRUT du SaveParameter de quelques Pals (pour figer les champs) ----
def _sample(dump, n):
    world = dump.get("properties", {}).get("worldSaveData", {}).get("value", {})
    out = []
    for e in _charmap(world):
        if _is_player(e):
            continue
        key = e.get("key", {})
        out.append({
            "instance_id": str((key.get("InstanceId", {}) or {}).get("value", "") or ""),
            "player_uid_key": str((key.get("PlayerUId", {}) or {}).get("value", "") or ""),
            "save_parameter": _save_param(e),   # dict brut, tel que décodé par palsav
        })
        if len(out) >= n:
            break
    return json.dumps(_sanitize(out), cls=CustomEncoder, allow_nan=False, ensure_ascii=False)


def debug_gvas(raw, n=3):
    """SaveParameter brut de n Pals depuis un GVAS déjà décompressé (Oodle décompressé en JS)."""
    return _sample(_read_gvas(raw).dump(), int(n))


def debug_save(data, n=3):
    """SaveParameter brut de n Pals depuis une save zlib (PlZ/CNK)."""
    raw_gvas, _ = decompress_sav_to_gvas(bytes(data))
    return _sample(_read_gvas(raw_gvas).dump(), int(n))


# ---- Debug : bases, travail, objets de map (pour concevoir l'extraction par camp) ----
def _values(prop):
    """Liste des éléments d'un ArrayProperty/Map, de façon défensive."""
    v = (prop or {}).get("value", None)
    if isinstance(v, dict) and "values" in v:
        return v["values"] or []
    if isinstance(v, list):
        return v
    return []


def _world_debug(dump, work_n, mapobj_n):
    world = dump.get("properties", {}).get("worldSaveData", {}).get("value", {})
    work = _values(world.get("WorkSaveData"))
    mapobj = _values(world.get("MapObjectSaveData"))
    out = {
        "bases": world.get("BaseCampSaveData", {}).get("value", []),  # peu nombreux -> complet
        "work_total": len(work),
        "work_sample": work[:int(work_n)],
        "map_object_total": len(mapobj),
        "map_object_sample": mapobj[:int(mapobj_n)],
    }
    return json.dumps(_sanitize(out), cls=CustomEncoder, allow_nan=False, ensure_ascii=False)


def debug_world_gvas(raw, work_n=15, mapobj_n=3):
    return _world_debug(_read_gvas(raw).dump(), work_n, mapobj_n)


def debug_world_save(data, work_n=15, mapobj_n=3):
    raw_gvas, _ = decompress_sav_to_gvas(bytes(data))
    return _world_debug(_read_gvas(raw_gvas).dump(), work_n, mapobj_n)
