#!/usr/bin/env python3
"""
Riporta nel pool gli outfit con immagine già pagata che le regole ATTUALI
approverebbero ancora.

Il problema che risolve: la beam search sceglie il massimo, e a ogni ritocco
dei punteggi il massimo si sposta di un soffio. L'outfit della foto — quattro
capi su cinque identici al nuovo vincitore — usciva dal pool per 0,016 di
differenza, e con lui l'immagine da 0,134 $. Moltiplicato per una
rigenerazione intera: 69 orfane, di cui 68 ancora perfettamente valide.

Il criterio NON è "ha una foto, quindi resta": ogni composizione viene
rivalutata da zero con i punteggi e le regole di oggi — soglia del pool,
needs_vision_review, genere, stagione a coppie, dispersione di formalità,
R1-R4. Chi non passa resta orfano, ed è giusto così: la foto è un costo
sommerso, non un lasciapassare.

Le composizioni si cercano in tutti i pool storici (outfits_pool.jsonl*): un
outfit generato una volta è descritto in almeno un backup. I punteggi salvati
vengono RICALCOLATI, non copiati.

Uso:
    python3 ripesca_orfane.py --prova    # mostra e basta
    python3 ripesca_orfane.py
"""

import argparse
import glob
import itertools
import json
import os
import shutil
from pathlib import Path

import outfit_generation as og
import scoring as sc

# la soglia non è cablata: segue quella del pool (vedi run_outfit_pipeline)
SOGLIA = og.OPTIONAL_SLOT_MIN_SCORE

BASE = Path(__file__).resolve().parent
POOL = BASE / "outfits_pool.jsonl"
IMMAGINI = BASE / "outfit_images"
MINIATURE = BASE / "outfit_thumbs"


def valida(o: dict, df) -> tuple:
    """(score, None) se la composizione passa le regole attuali, altrimenti
    (score, motivo). Replica i vincoli di candidates_for_slot su un outfit
    già composto."""
    items = []
    for s, v in o["slots"].items():
        if not v:
            continue
        if v["relpath"] not in df.index:
            return None, "capo sparito dal catalogo"
        items.append((s, df.loc[v["relpath"]]))
    rows = dict(items)

    if any(r["needs_vision_review"] for _, r in items):
        return None, "needs_vision_review"

    coppie = {}
    for (sa, a), (sb, b) in itertools.combinations(items, 2):
        coppie[f"{sa}-{sb}"] = sc.score_pair(a, b)["score"]
    m = min(coppie.values())
    if m < SOGLIA:
        return m, f"score sotto {SOGLIA}"

    generi = {r["gender"] for _, r in items} - {None}
    if len(generi) > 1:
        return m, "genere misto"
    for (_, a), (_, b) in itertools.combinations(items, 2):
        if not (a["season"] == "tutte" or b["season"] == "tutte" or a["season"] == b["season"]):
            return m, f"stagioni {a['season']}/{b['season']}"
    fs = [r["formality_norm"] for _, r in items]
    if max(fs) - min(fs) > og.FORMALITY_SPREAD_MAX:
        return m, "dispersione formalita'"

    top, bot, ow, sh = (rows.get(k) for k in ("top", "bottom", "outerwear", "shoes"))
    if bot is not None and bot["leg_length"] == "corta":
        if top is not None and top["sleeve"] != "corta":
            return m, "R1 maniche lunghe su shorts"
        if ow is not None:
            return m, "R2 giacca su shorts"
    if any(r["season"] == "inverno" for _, r in items) and (
            (bot is not None and bot["leg_length"] == "corta")
            or (top is not None and top["sleeve"] == "corta")):
        return m, "R1 capo invernale su pelle scoperta"
    if sh is not None and sh["mocassino"] and top is not None and top["top_senza_collo"]:
        return m, "R3 mocassino su top senza collo"
    if ow is not None and ow["cappotto"] and bot is not None and bot["bottom_da_tuta"]:
        return m, "R4 cappotto su tuta"
    return m, None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prova", action="store_true")
    args = ap.parse_args()

    df = og.load_and_prepare(str(BASE / "features_clustered.parquet")).set_index("relpath", drop=False)
    pool = [json.loads(l) for l in open(POOL, encoding="utf-8")]
    nel_pool = {o["outfit_id"] for o in pool}

    composizioni = {}
    for f in sorted(glob.glob(str(BASE / "outfits_pool.jsonl*"))):
        for l in open(f, encoding="utf-8"):
            o = json.loads(l)
            composizioni.setdefault(o["outfit_id"], o)

    pagate = set()
    for cartella in (IMMAGINI, BASE / "outfit_images_superate"):
        pagate |= {p.stem for p in cartella.glob("*.png")} if cartella.exists() else set()
    orfane = sorted(pagate - nel_pool)
    print(f"[*] immagini pagate: {len(pagate)}, fuori dal pool: {len(orfane)}")

    ripescati, respinti = [], []
    for oid in orfane:
        o = composizioni.get(oid)
        if o is None:
            respinti.append((oid, "composizione ignota")); continue
        m, motivo = valida(o, df)
        if motivo:
            respinti.append((oid, motivo)); continue
        # punteggi ricalcolati, non copiati dal pool vecchio
        items = [(s, df.loc[v["relpath"]]) for s, v in o["slots"].items() if v]
        coppie = {f"{sa}-{sb}": round(sc.score_pair(a, b)["score"], 3)
                  for (sa, a), (sb, b) in itertools.combinations(items, 2)}
        o = dict(o, outfit_score=round(min(coppie.values()), 3), pairwise_scores=coppie)
        ripescati.append(o)

    print(f"[*] ripescabili: {len(ripescati)}, respinti: {len(respinti)}")
    for oid, motivo in respinti:
        print(f"    [no] {oid}  {motivo}")
    for o in ripescati:
        print(f"    [ok] {o['outfit_id']}  {o['outfit_score']:.3f}  {o['label'][:60]}")

    if args.prova:
        print("\n(prova: non ho toccato niente)")
        return
    if not ripescati:
        return

    shutil.copy2(POOL, POOL.with_suffix(".jsonl.prima_ripescaggio.bak"))
    with open(POOL, "a", encoding="utf-8") as f:
        for o in ripescati:
            f.write(json.dumps(o, ensure_ascii=False) + "\n")

    # le immagini eventualmente finite fra le superate tornano operative
    tornati = 0
    for o in ripescati:
        for cartella, suff in ((IMMAGINI, ".png"), (MINIATURE, ".webp")):
            sup = cartella.parent / f"{cartella.name}_superate" / f"{o['outfit_id']}{suff}"
            if sup.exists():
                shutil.move(str(sup), str(cartella / sup.name)); tornati += 1
    print(f"\n[OK] pool: {len(pool)} -> {len(pool) + len(ripescati)} outfit")
    print(f"     {tornati} file recuperati da *_superate")


if __name__ == "__main__":
    main()
