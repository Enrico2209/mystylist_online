#!/usr/bin/env python3
"""
Toglie dal pool gli outfit che una regola nuova non ammette più.

Serve per non dover rigenerare tutto. Rigenerare il pool rifà la beam search da
capo: le composizioni cambiano, gli outfit_id con loro, e le immagini già pagate
diventano orfane a centinaia. Quando una regola nuova riguarda pochi outfit,
toglierli e basta costa zero e non tocca nessuno degli altri.

Quello che questo script NON fa è rimpiazzarli: i posti liberati restano vuoti
fino alla prossima rigenerazione completa. È un potatura, non una ricostruzione.

Uso:
    python3 pota_pool.py --prova      # dice cosa toglierebbe, non tocca niente
    python3 pota_pool.py
"""

import argparse
import json
import shutil
from pathlib import Path

import outfit_generation as og

BASE = Path(__file__).resolve().parent
POOL = BASE / "outfits_pool.jsonl"
IMMAGINI = BASE / "outfit_images"
MINIATURE = BASE / "outfit_thumbs"


def viola_regola_calzature(outfit: dict, mocassini: set, top_informali: set) -> bool:
    scarpe = outfit["slots"].get("shoes")
    top = outfit["slots"].get("top")
    if not scarpe or not top:
        return False
    return scarpe["relpath"] in mocassini and top["relpath"] in top_informali


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prova", action="store_true", help="mostra e basta")
    args = ap.parse_args()

    df = og.load_and_prepare(str(BASE / "features_clustered.parquet"))
    mocassini = set(df.loc[df["mocassino"], "relpath"])
    top_informali = set(df.loc[df["top_senza_collo"], "relpath"])
    print(f"[*] {len(mocassini)} calzature classificate mocassino/barca")

    pool = [json.loads(l) for l in open(POOL, encoding="utf-8")]
    da_togliere = [o for o in pool if viola_regola_calzature(o, mocassini, top_informali)]

    print(f"[*] {len(da_togliere)} outfit su {len(pool)} violano la Regola 3 "
          f"({len(da_togliere) / len(pool) * 100:.1f}%)")
    con_foto = [o for o in da_togliere if (IMMAGINI / f"{o['outfit_id']}.png").exists()]
    print(f"    di cui con immagine già generata: {len(con_foto)}")
    for o in da_togliere:
        segno = "foto" if (IMMAGINI / f"{o['outfit_id']}.png").exists() else "   —"
        print(f"    [{segno}] {o['outfit_id']}  {o['slots']['top']['title'][:34]:34s}"
              f" + {o['slots']['shoes']['title'][:38]}")

    if args.prova:
        print("\n(prova: non ho toccato niente)")
        return
    if not da_togliere:
        return

    shutil.copy2(POOL, POOL.with_suffix(".jsonl.prima_calzature.bak"))
    tolti = {o["outfit_id"] for o in da_togliere}
    with open(POOL, "w", encoding="utf-8") as f:
        for o in pool:
            if o["outfit_id"] not in tolti:
                f.write(json.dumps(o, ensure_ascii=False) + "\n")

    # le immagini degli outfit tolti seguono la stessa sorte di quelle superate
    # da una rigenerazione: si spostano, non si cancellano — sono costate
    for cartella, suffisso in ((IMMAGINI, ".png"), (MINIATURE, ".webp")):
        superate = cartella.parent / f"{cartella.name}_superate"
        superate.mkdir(exist_ok=True)
        for oid in tolti:
            p = cartella / f"{oid}{suffisso}"
            if p.exists():
                shutil.move(str(p), str(superate / p.name))

    print(f"\n[OK] pool: {len(pool)} -> {len(pool) - len(tolti)} outfit")
    print(f"     backup in {POOL.with_suffix('.jsonl.prima_calzature.bak').name}")
    print(f"     {len(con_foto)} immagini spostate in outfit_images_superate")


if __name__ == "__main__":
    main()
