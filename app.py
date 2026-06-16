"""
Palworld - Assistant de camp
Petit serveur Flask qui sert l'interface web et fournit les donnees des Pals
ainsi que le calcul du recapitulatif des competences de travail d'un camp.
"""
import json
from pathlib import Path

from flask import Flask, jsonify, render_template, request

from build_data import WORK_TYPES, WORK_IDS

BASE_DIR = Path(__file__).parent
DATA_FILE = BASE_DIR / "data" / "pals.json"
STRUCT_FILE = BASE_DIR / "data" / "structures.json"

app = Flask(__name__)


def load_pals():
    """Charge la liste des Pals depuis data/pals.json."""
    if not DATA_FILE.exists():
        return []
    with DATA_FILE.open(encoding="utf-8") as f:
        pals = json.load(f)
    # Normalise : on s'assure que chaque Pal a un dict "work" complet (0 par defaut).
    for p in pals:
        work = p.get("work", {}) or {}
        p["work"] = {wid: int(work.get(wid, 0)) for wid in WORK_IDS}
        p["nightWorker"] = bool(p.get("nightWorker", False))
    return pals


def load_structures():
    """Charge la liste des constructions depuis data/structures.json."""
    if not STRUCT_FILE.exists():
        return []
    with STRUCT_FILE.open(encoding="utf-8") as f:
        structures = json.load(f)
    for s in structures:
        # On ne garde que des identifiants de competence connus.
        s["requires"] = [r for r in s.get("requires", []) if r in WORK_IDS]
    return structures


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/pals")
def api_pals():
    """Renvoie les competences, la liste des Pals et celle des constructions."""
    return jsonify({
        "workTypes": WORK_TYPES,
        "pals": load_pals(),
        "structures": load_structures(),
    })


def _parse_qty(raw):
    """Convertit {id(str): qty} en {id(int): qty} en ignorant les quantites <= 0."""
    out = {}
    for k, v in (raw or {}).items():
        try:
            i, q = int(k), int(v)
        except (ValueError, TypeError):
            continue
        if q > 0:
            out[i] = q
    return out


@app.route("/api/summary", methods=["POST"])
def api_summary():
    """
    Recoit le camp { pals: {id: qty}, structures: {id: qty} } et renvoie, pour chaque
    competence :
      - count     : Pals (exemplaires compris) fournissant la competence  (offre)
      - maxLevel  : niveau max present dans le camp
      - pals      : detail des Pals concernes
      - demand    : nombre de constructions (exemplaires compris) qui la requierent
      - structures: detail des constructions concernees
      - covered   : True si la competence requise est fournie par au moins un Pal
    Plus les totaux (Pals, travailleurs de nuit, constructions, compétences non couvertes).
    """
    payload = request.get_json(silent=True) or {}
    pal_qty = _parse_qty(payload.get("pals"))
    struct_qty = _parse_qty(payload.get("structures"))

    pals_by_id = {p["id"]: p for p in load_pals()}
    structs_by_id = {s["id"]: s for s in load_structures()}
    pal_members = [(pals_by_id[i], q) for i, q in pal_qty.items() if i in pals_by_id]
    struct_members = [(structs_by_id[i], q) for i, q in struct_qty.items() if i in structs_by_id]

    total_pals = sum(q for _, q in pal_members)
    night = sum(q for p, q in pal_members if p["nightWorker"])
    total_structs = sum(q for _, q in struct_members)

    summary = []
    uncovered = 0
    for w in WORK_TYPES:
        wid = w["id"]
        contributors = [
            {"id": p["id"], "name": p["name"], "level": p["work"][wid], "qty": q}
            for p, q in pal_members
            if p["work"].get(wid, 0) > 0
        ]
        contributors.sort(key=lambda c: (-c["level"], c["name"]))
        consumers = [
            {"id": s["id"], "name": s["name"], "qty": q}
            for s, q in struct_members
            if wid in s["requires"]
        ]
        consumers.sort(key=lambda c: c["name"])

        count = sum(c["qty"] for c in contributors)
        demand = sum(c["qty"] for c in consumers)
        covered = demand == 0 or count > 0
        if demand > 0 and count == 0:
            uncovered += 1

        summary.append({
            "id": wid,
            "label": w["label"],
            "icon": w["icon"],
            "count": count,
            "maxLevel": max((c["level"] for c in contributors), default=0),
            "pals": contributors,
            "demand": demand,
            "structures": consumers,
            "covered": covered,
        })

    return jsonify({
        "summary": summary,
        "campSize": total_pals,
        "nightWorkers": night,
        "structureCount": total_structs,
        "uncovered": uncovered,
    })


if __name__ == "__main__":
    app.run(debug=True, port=5000)
