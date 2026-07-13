"""Stub du module natif `palooz` (extension C++ Oodle) pour le navigateur.

`palsav.core` instancie `OozLib()` au niveau module, ce qui déclenche
`import palooz` dès l'import de `palsav`. Ce stub fait réussir l'import.

La décompression Oodle réelle est faite côté JavaScript par ooz.wasm ; ce module
n'est donc jamais appelé pour décoder une save PlM. Il lève une erreur claire s'il
l'était (ex. si on appelait parse_save() au lieu de parse_gvas() sur du PlM).
"""

_MSG = (
    "Oodle géré côté JavaScript (ooz.wasm) : décompressez le PlM en JS puis appelez "
    "palsav_api.parse_gvas(raw). Le module natif 'palooz' n'est pas embarqué en WASM."
)


def decompress(compressed_data, uncompressed_len):
    raise NotImplementedError(_MSG)


def compress(compressor, level, data, uncompressed_len):
    raise NotImplementedError(_MSG)
