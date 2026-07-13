// Wrapper WASM : expose la décompression Oodle/Kraken de `ooz` à JavaScript.
// Seule la DÉCOMPRESSION est nécessaire pour LIRE une sauvegarde Palworld.
//
// Ce fichier est notre code (glue). La lib `ooz` compilée avec lui est en
// GPL-3.0 (voir LICENSES/), donc ooz.mjs/ooz.wasm générés sont GPL-3.0.
#include <cstdint>
#include <cstddef>
#include <emscripten/emscripten.h>

// Défini dans kraken.cpp (linkage C++). Retourne le nombre d'octets écrits.
int Kraken_Decompress(const uint8_t *src, size_t src_len, uint8_t *dst, size_t dst_len);

extern "C" {

EMSCRIPTEN_KEEPALIVE
int ooz_decompress(const uint8_t *src, int src_len, uint8_t *dst, int dst_len) {
    return Kraken_Decompress(src, (size_t)src_len, dst, (size_t)dst_len);
}

}
