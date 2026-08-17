#!/usr/bin/env python3
"""
Nuvolari — Fase 6: generazione outfit
========================================

A partire da un capo "ancora", costruisce outfit completi (top/bottom/
scarpe/outerwear opz./accessorio opz.) usando beam search: ad ogni slot
si tengono aperte le `beam_width` combinazioni parziali migliori, non solo
la scelta migliore al passo precedente — così un primo abbinamento
localmente ottimo ma che poi si rivela un vicolo cieco (es. bottom che sta
bene con l'ancora ma stona con le scarpe migliori) non blocca la ricerca.

Candidati per ogni slot filtrati per:
  - needs_vision_review=False (i capi con segnale di stile inaffidabile —
    tag "confermati" solo da materiale/brand generico, senza riscontro nel
    testo — sono esclusi da subito: vedi derive_attributes in
    scrape_with_attributes.py per la logica)
  - slot (tipo di capo, dedotto dal titolo — vedi classify_slot)
  - genere (dedotto dal titolo "UOMO"/"DONNA", fallback su category_path)
  - stagione compatibile (stessa stagione o "tutte")
  - cluster stilistico compatibile (stesso style_cluster; se uno dei due è
    outlier -1, il filtro cluster non si applica e si lascia decidere solo
    allo score — escludere a priori il 44% di outlier del catalogo
    sarebbe uno spreco, vedi Fase 4). Per gli slot OPZIONALI (outerwear/
    accessorio) il filtro è più severo: i candidati outlier non sono
    ammessi, un pezzo bonus sbagliato è peggio di nessun pezzo bonus.
  - dispersione di formalità nell'outfit: un capo non può entrare se la
    differenza tra il suo formality_norm e quello già presente nell'outfit
    (min/max) supera FORMALITY_SPREAD_MAX — non basta che lo score
    pairwise sia buono, la formalità dell'outfit intero deve restare
    coerente (es. un panciotto sartoriale non può convivere con sneakers
    casual e cappello, anche se il coseno di stile tra i due sembra alto)
  - Regola 1 (coerenza stagionale manica/gamba): se il bottom è a gamba
    corta (bermuda/short), il top DEVE avere maniche corte — niente
    maglioni/felpe/camicie a manica lunga sui pantaloncini. Regola
    unidirezionale: un top a manica corta con pantaloni lunghi resta
    ammesso (es. capo di mezza stagione). Vedi classify_sleeve/
    classify_leg_length e _seasonal_coherence_ok.
  - Regola 2 (niente giacca sui pantaloncini): lo slot outerwear è escluso
    del tutto se il bottom scelto è a gamba corta — vedi _outerwear_allowed.
    (La parte "niente felpe sui pantaloncini" della stessa richiesta è già
    coperta dalla Regola 1, perché una felpa ha sempre manica lunga per
    tipo di capo.)

score(A,B) dalla Fase 5. Outfit score finale = MINIMO dei pairwise score fra
tutti i capi scelti, non media: una media può nascondere un singolo
abbinamento pessimo dietro tanti abbinamenti buoni (visto succedere in
pratica — vedi conversazione), quindi il punteggio outfit riflette
l'anello più debole della catena, non la sua forza media.

Uso in notebook
-----------------
    %run outfit_generation.py

    df = load_and_prepare('/Users/enricociaralli/Desktop/nuvolari/features_clustered.parquet')
    outfits = generate_outfits(df, n_outfits=10)
    for o in outfits:
        print(o['outfit_score'], {slot: item['title'] for slot, item in o['slots'].items() if item})
"""

import hashlib
import json
import re
from pathlib import Path

import pandas as pd

from clustering import STYLE_TAG_COLUMNS
from scoring import COLONNA_PALETTE, COLONNA_VETTORE, score_pair

GARMENT_TYPE_KEYWORDS = {
    "top": ["camicia", "camicie", "t-shirt", "tshirt", "maglia", "maglie", "maglietta",
            "polo", "canotta", "canotte", "felpa", "felpe", "top", "blusa", "camicetta",
            "body", "overshirt", "maglione", "pullover", "pull", "cardigan"],
    "bottom": ["pantalone", "pantaloni", "jeans", "bermuda", "short", "shorts", "gonna",
               "leggings", "pantaloncini"],
    "outerwear": ["giacca", "giacche", "giubbotto", "giubbotti", "cappotto", "piumino",
                  "bomber", "parka", "trench", "blazer", "gilet", "tracktop", "anorak",
                  "jkt", "windbreaker", "giaccone"],
    "shoes": ["scarpe", "scarpa", "sneakers", "sneaker", "stivaletto", "stivaletti",
              "mocassino", "mocassini", "sandali", "sandalo", "ciabatte", "stringate",
              "ballerine"],
    "accessory": ["borsa", "tracolla", "zaino", "cintura", "cappello", "sciarpa", "guanti",
                  "occhiali", "portafoglio", "calzini", "cravatta", "berretto"],
    # abiti/completi/costumi sono "capi unici" (coprono da soli top+bottom):
    # fuori scope per la generazione a slot in questa v1, vedi nota sotto.
    "dress_or_suit": ["abito", "vestito", "tuta", "completo", "costume"],
}

MANDATORY_SLOTS = ["top", "bottom", "shoes"]
OPTIONAL_SLOTS = ["outerwear", "accessory"]
OPTIONAL_SLOT_MIN_SCORE = 0.5  # sotto questa soglia, meglio niente accessorio/outerwear che uno stonato


_KEYWORD_TO_SLOT = {kw: slot for slot, kws in GARMENT_TYPE_KEYWORDS.items() for kw in kws}


def _find_slot_and_keyword(title: str):
    """Il tipo di capo è quasi sempre la prima parola del titolo (es.
    "SCARPE HEYDUDE..."), ma altre parole del titolo (es. il nome del
    colore "N.BLAZER/B TAN" di una sneaker) possono corrispondere per
    caso a una parola chiave di UN'ALTRA categoria. Per questo si scansiona
    il titolo parola per parola, da sinistra, e si prende il primo match —
    non "la prima categoria del dizionario con un match ovunque nel testo"."""
    if not title:
        return None, None
    # il trattino va mantenuto nel token: "t-shirt" tokenizzato senza trattino
    # diventerebbe "t" + "shirt", nessuno dei due presente nel dizionario, e la
    # scansione proseguirebbe fino a un'altra parola nel titolo che potrebbe
    # corrispondere per sbaglio a un'ALTRA categoria (successo con capi di
    # marchi tipo "Guess Jeans": "jeans" nel nome del brand veniva letto come
    # tipo di capo, non "t-shirt" come tipo di capo reale)
    words = re.findall(r"[a-zà-ü'-]+", title.lower())
    for w in words:
        if w in _KEYWORD_TO_SLOT:
            return _KEYWORD_TO_SLOT[w], w
    return None, None


def classify_slot(title: str):
    slot, _keyword = _find_slot_and_keyword(title)
    return slot


SHORT_SLEEVE_KEYWORDS = {"t-shirt", "tshirt", "polo", "canotta", "canotte", "maglietta", "top"}
LONG_SLEEVE_KEYWORDS = {"maglia", "maglie", "felpa", "felpe", "maglione", "pullover", "pull",
                         "cardigan", "overshirt"}
# camicia/camicie/blusa/camicetta/body: manica ambigua dal solo tipo di capo,
# serve la sottocategoria del sito o il testo (vedi classify_sleeve)

SHORT_LEG_KEYWORDS = {"bermuda", "short", "shorts", "pantaloncini"}


def classify_sleeve(title: str, relpath: str):
    """Lunghezza manica del top: 'corta' o 'lunga' — necessaria per la
    Regola 1 (bermuda nell'outfit -> il top deve avere maniche corte,
    altrimenti stona per coerenza stagionale). Alcuni tipi di capo hanno la
    manica implicita nel nome (t-shirt/polo/canotta = sempre corta; maglia/
    felpa/maglione = sempre lunga); per camicia/blusa (ambigue) si usa prima
    la sottocategoria del sito (.../manica-lunga/... o .../mezza-manica/...,
    copre il 97% delle camicie), poi il testo del titolo. Se non
    determinabile, default 'lunga' — scelta conservativa: meglio escludere
    un top per sbaglio che abbinarlo a un bermuda se in realtà è invernale.
    """
    _slot, keyword = _find_slot_and_keyword(title)
    if keyword in SHORT_SLEEVE_KEYWORDS:
        return "corta"
    if keyword in LONG_SLEEVE_KEYWORDS:
        return "lunga"
    rp = (relpath or "").lower()
    if "manica-lunga" in rp:
        return "lunga"
    if "mezza-manica" in rp:
        return "corta"
    t = (title or "").lower()
    if "manica corta" in t or "mezza manica" in t:
        return "corta"
    if "manica lunga" in t:
        return "lunga"
    return "lunga"


def classify_leg_length(title: str):
    """Lunghezza gamba del bottom: 'corta' (bermuda/short/pantaloncini) o
    'lunga' (pantaloni/jeans/leggings). Serve sia alla Regola 1 (coerenza
    col top) sia alla Regola 2 (niente giacche sui pantaloncini)."""
    _slot, keyword = _find_slot_and_keyword(title)
    return "corta" if keyword in SHORT_LEG_KEYWORDS else "lunga"


# --- Regola 3 (utente): il mocassino vuole un top con un collo -------------
#
# "Un mocassino è troppo elegante per stare con maglie che non sono polo o
# camicie". La formalità da sola non bastava a tenerli separati: un mocassino
# sta a 3 e una t-shirt a 2, cioè un solo gradino, e FORMALITY_SPREAD_MAX ne
# tollera esattamente uno.
#
# Solo parole che nominano LA FORMA. Restano fuori di proposito:
#   slip-on   -> lo sono anche le Vans Authentic
#   stringato -> vuol dire allacciato, lo sono anche le running
#   ballerina -> è una scarpa da donna piatta, non un mocassino
CALZATURA_ELEGANTE = re.compile(
    r"(mocassin[oi]|loafer|penny loafer|scarp[ae] da barca|boat shoe)", re.I)

# Frase di repertorio del catalogo: elenca i reparti del negozio, non descrive
# il prodotto. Senza questa esclusione un anfibio e una New Balance risultavano
# mocassini perché la scheda diceva "disponibili in vari stili come sneakers,
# scarpe eleganti, stivali o mocassini".
DESCRIZIONE_DI_REPERTORIO = re.compile(r"variet[àa] di stili come", re.I)

# Quando è la sola descrizione a parlare, si accettano solo le forme che un
# copywriter non usa per traslato. "Mocassino" da solo non basta: la scheda
# della Vans Authentic — una skate shoe in tela, verificata sulla foto — la
# chiama "questo mocassino sportivo". "Scarpa da barca" e "loafer" no: quelle
# nominano un oggetto preciso.
FORMA_INEQUIVOCABILE = re.compile(r"(scarp[ae] da barca|boat shoe|loafer)", re.I)

# Top che con un mocassino non ci stanno. La maglieria (maglia, maglione,
# cardigan) NON è qui: il maglione col mocassino è un abbinamento classico,
# e in italiano "maglia" vuol dire quasi sempre quello.
TOP_SENZA_COLLO = {"t-shirt", "tshirt", "maglietta", "canotta", "canotte", "top", "felpa", "felpe"}


def classify_calzatura(title: str, descrizione: str = "") -> bool:
    """Vero se la scarpa ha la forma del mocassino o della scarpa da barca.

    Guarda anche la descrizione, non solo il titolo, perché il titolo mente: la
    scarpa in camoscio beige della segnalazione si chiama "SNEAKERS UOMO FRED
    PERRY B2346" ed è archiviata fra le sneakers, ma la sua stessa scheda dice
    "rilegge la silhouette classica della scarpa da barca". Sono 7 casi su 28:
    un quarto dei mocassini del catalogo non si dichiara tale nel titolo.
    """
    if CALZATURA_ELEGANTE.search(title or ""):
        return True
    if DESCRIZIONE_DI_REPERTORIO.search(descrizione or ""):
        return False
    return bool(FORMA_INEQUIVOCABILE.search(descrizione or ""))


def classify_top_senza_collo(title: str) -> bool:
    """Vero se il top è una t-shirt, una canotta, un top o una felpa."""
    _slot, keyword = _find_slot_and_keyword(title)
    return keyword in TOP_SENZA_COLLO


# --- Regola 4 (utente): il cappotto non va sopra una tuta -----------------
#
# Stessa storia del mocassino, sul capospalla: "giubbotto" non dice il registro.
# Il caban di lana blu doppiopetto a sei bottoni — verificato sulla foto del
# prodotto — si chiama GIUBBOTTO UOMO NUVOLARI OTIS NAVY e sta a formalità 2,
# quindi finiva sopra una tuta con le sneakers.
#
# Il vincolo non passa dalla formalità di proposito: alzare quel capo da 2 a 3
# non avrebbe tolto l'outfit (la dispersione ammessa è esattamente un gradino,
# 0.25 <= 0.30), e alzarlo a 4 lo avrebbe tolto anche dagli abbinamenti giusti
# col jeans. La formalità è un asse solo: dice quanto, non dice con cosa.
FORMA_CAPPOTTO = re.compile(r"(caban|montgomery|doppiopetto|sei bottoni|peacoat|cappotto|trench)", re.I)

# Un gilet imbottito e una giacca a vento citano il cappotto nella scheda ma
# cappotti non sono: il titolo qui è affidabile e ha l'ultima parola.
NON_E_UN_CAPPOTTO = re.compile(r"\b(gilet|giacca a vento|piumino|smanicato)\b", re.I)

BOTTOM_DA_TUTA = re.compile(r"\b(tuta|jogger\w*|sweatpant\w*)\b", re.I)


def classify_cappotto(title: str, descrizione: str = "") -> bool:
    """Vero se il capospalla ha la forma di un cappotto (caban compreso)."""
    if NON_E_UN_CAPPOTTO.search(title or ""):
        return False
    if FORMA_CAPPOTTO.search(title or ""):
        return True
    if DESCRIZIONE_DI_REPERTORIO.search(descrizione or ""):
        return False
    return bool(FORMA_CAPPOTTO.search(descrizione or ""))


def classify_bottom_da_tuta(title: str) -> bool:
    return bool(BOTTOM_DA_TUTA.search(title or ""))


CATALOGO = Path(__file__).resolve().parent / "nuvolari_full_organizzato"


def _descrizioni(relpath_voluti: set) -> dict:
    """relpath -> description_text, solo per i capi richiesti.

    Il parquet porta il titolo ma non la descrizione, e la descrizione è
    l'unico posto dove sta la forma del capo: la scarpa da barca che si chiama
    "sneakers", il caban che si chiama "giubbotto". Si legge dal catalogo, che è
    la stessa fonte da cui il parquet è nato. Se il catalogo non c'è (una copia
    del solo codice) si continua senza: le regole perdono i casi che si
    dichiarano solo nella scheda, non l'intero funzionamento.
    """
    if not CATALOGO.exists():
        return {}
    out = {}
    for p in CATALOGO.rglob("metadata.json"):
        rel = str(p.parent.relative_to(CATALOGO))
        if rel not in relpath_voluti:
            continue
        try:
            out[rel] = json.loads(p.read_text(encoding="utf-8")).get("description_text") or ""
        except (OSError, ValueError):
            continue
    return out


# Accessori che, quando il titolo non dichiara il genere, non vanno trattati
# come unisex. Sono capi connotati: una tracolla street senza indicazione
# risultava "neutra" e finiva su outfit donna. Cappelli, occhiali, zaini e
# sciarpe restano invece genuinamente trasversali e non compaiono qui.
ACCESSORI_MASCHILI = r"\b(borsa|borse|tracolla|tracolle|marsupio|marsupi)\b"


def classify_gender(title: str, relpath: str):
    t = (title or "").lower()
    if re.search(r"\bdonna\b", t):
        return "donna"
    if re.search(r"\buomo\b", t):
        return "uomo"
    # fallback sul percorso di categoria, meno affidabile del titolo
    if "abbigliamento-donna" in (relpath or ""):
        return "donna"
    # borse e tracolle senza genere dichiarato: assegnate a uomo invece che
    # lasciate neutre, altrimenti il jolly del genere le fa entrare ovunque
    if re.search(ACCESSORI_MASCHILI, t):
        return "uomo"
    return None  # genere non determinato -> trattato come compatibile con entrambi


SEASONS = ["estate", "inverno", "mezza_stagione", "tutte"]


def _season_label(row: pd.Series) -> str:
    for s in SEASONS:
        if row.get(f"season_{s}") == 1.0:
            return s
    return "tutte"


def load_and_prepare(features_parquet: str) -> pd.DataFrame:
    """Carica features_clustered.parquet e aggiunge le colonne slot/gender/
    season/sleeve/leg_length necessarie per la generazione outfit (season è
    ricostruita dalle colonne one-hot season_* della Fase 3; le altre sono
    dedotte dal titolo/percorso, vedi sopra)."""
    df = pd.read_parquet(features_parquet)
    df["slot"] = df["title"].apply(classify_slot)
    df["gender"] = df.apply(lambda r: classify_gender(r["title"], r["relpath"]), axis=1)
    df["season"] = df.apply(_season_label, axis=1)
    df["sleeve"] = df.apply(lambda r: classify_sleeve(r["title"], r["relpath"]), axis=1)
    df["leg_length"] = df["title"].apply(classify_leg_length)

    # La forma del capo è l'unico attributo che il titolo non basta a dare (vedi
    # classify_calzatura e classify_cappotto): serve la descrizione, che sta nel
    # catalogo e non nel parquet. Si legge solo per scarpe e capispalla — 453
    # schede su 2901.
    interessati = set(df.loc[df["slot"].isin(["shoes", "outerwear"]), "relpath"])
    descrizioni = _descrizioni(interessati)
    df["mocassino"] = df.apply(
        lambda r: r["slot"] == "shoes"
        and classify_calzatura(r["title"], descrizioni.get(r["relpath"], "")), axis=1)
    df["top_senza_collo"] = df.apply(
        lambda r: r["slot"] == "top" and classify_top_senza_collo(r["title"]), axis=1)
    df["cappotto"] = df.apply(
        lambda r: r["slot"] == "outerwear"
        and classify_cappotto(r["title"], descrizioni.get(r["relpath"], "")), axis=1)
    df["bottom_da_tuta"] = df.apply(
        lambda r: r["slot"] == "bottom" and classify_bottom_da_tuta(r["title"]), axis=1)

    # Vettore di stile e tavolozza pronti da usare. Sono gli stessi valori di
    # sempre, solo già estratti: score_pair viene chiamata milioni di volte, e
    # rifare a ogni chiamata la selezione pandas per etichetta e il json.loads
    # della tavolozza costava il 70% del tempo di generazione del pool.
    df[COLONNA_VETTORE] = list(df[STYLE_TAG_COLUMNS].to_numpy(dtype=float))
    df[COLONNA_PALETTE] = df["color_palette"].apply(
        lambda p: json.loads(p) if isinstance(p, str) else p)
    return df


def _gender_compatible(a: str, b: str) -> bool:
    return a is None or b is None or a == b


def _season_compatible(a: str, b: str) -> bool:
    return a == "tutte" or b == "tutte" or a == b


def _cluster_compatible(a: int, b: int) -> bool:
    if a == -1 or b == -1:
        return True  # outlier: nessun filtro di cluster, decide solo score()
    return a == b


FORMALITY_SPREAD_MAX = 0.3  # formality_norm ha 5 livelli discreti (0, .25, .5, .75, 1) -> tollera un solo "gradino"


def _formality_range(items) -> tuple:
    values = [row["formality_norm"] for _, row in items]
    return min(values), max(values)


def _formality_ok(items, candidate_formality: float) -> bool:
    """Verifica che aggiungere candidate_formality non allarghi la dispersione
    di formalità dell'outfit oltre FORMALITY_SPREAD_MAX. Non basta che il
    candidato stia bene in coppia con ogni singolo capo già scelto (vedi
    style_match) — l'outfit nel suo insieme deve restare coerente: un pezzo
    molto più formale/informale degli altri stona anche se il suo score
    pairwise con ciascuno preso singolarmente sembrava accettabile."""
    lo, hi = _formality_range(items)
    new_lo, new_hi = min(lo, candidate_formality), max(hi, candidate_formality)
    return (new_hi - new_lo) <= FORMALITY_SPREAD_MAX


def _existing_value(current_items, slot: str, column: str):
    return next((row[column] for s, row in current_items if s == slot), None)


def _seasonal_coherence_ok(current_items, slot: str, candidate_row: pd.Series) -> bool:
    """Regola 1 (utente): se l'outfit ha un bottom a gamba corta (bermuda/
    short), il top deve avere maniche corte — un top invernale a maniche
    lunghe coi pantaloncini stona per coerenza stagionale. La regola è
    unidirezionale (un top a maniche corte con pantaloni lunghi è normale,
    es. mezza stagione), quindi si applica in entrambi gli ordini di
    riempimento slot senza vietare quel caso."""
    if slot == "top":
        existing_bottom_leg = _existing_value(current_items, "bottom", "leg_length")
        if existing_bottom_leg == "corta" and candidate_row["sleeve"] != "corta":
            return False
    elif slot == "bottom":
        existing_top_sleeve = _existing_value(current_items, "top", "sleeve")
        if candidate_row["leg_length"] == "corta" and existing_top_sleeve == "lunga":
            return False

    # Un capo dichiaratamente invernale non convive con la pelle scoperta,
    # qualunque slot occupi: la sciarpa sopra la t-shirt a maniche corte
    # nasceva proprio qui, perché il controllo esisteva solo fra top e bottom
    # e gli accessori non lo attraversavano mai.
    gambe_scoperte = _existing_value(current_items, "bottom", "leg_length") == "corta"
    braccia_scoperte = _existing_value(current_items, "top", "sleeve") == "corta"
    if candidate_row["season"] == "inverno" and (gambe_scoperte or braccia_scoperte):
        return False
    if candidate_row["leg_length"] == "corta" or candidate_row["sleeve"] == "corta":
        if any(r["season"] == "inverno" for _, r in current_items):
            return False
    return True


def _calzatura_ok(current_items, slot: str, candidate_row: pd.Series) -> bool:
    """Regola 3 (utente): niente t-shirt, canotte, top o felpe sotto un
    mocassino. Vale nei due ordini di riempimento, perché le scarpe possono
    entrare prima o dopo il top."""
    if slot == "shoes" and candidate_row["mocassino"]:
        if _existing_value(current_items, "top", "top_senza_collo"):
            return False
    elif slot == "top" and candidate_row["top_senza_collo"]:
        if _existing_value(current_items, "shoes", "mocassino"):
            return False
    return True


def _cappotto_ok(current_items, slot: str, candidate_row: pd.Series) -> bool:
    """Regola 4 (utente): niente cappotto o caban sopra una tuta."""
    if slot == "outerwear" and candidate_row["cappotto"]:
        if _existing_value(current_items, "bottom", "bottom_da_tuta"):
            return False
    elif slot == "bottom" and candidate_row["bottom_da_tuta"]:
        if _existing_value(current_items, "outerwear", "cappotto"):
            return False
    return True


def _outerwear_allowed(current_items) -> bool:
    """Regola 2 (utente): giacche/outerwear solo se i pantaloni sono lunghi
    — niente giacca sui pantaloncini. (La parte "niente felpe sui
    pantaloncini" della stessa regola è già coperta dalla Regola 1, perché
    una felpa ha sempre manica lunga per tipo di capo.)"""
    existing_bottom_leg = _existing_value(current_items, "bottom", "leg_length")
    return existing_bottom_leg != "corta"


def _filtra(candidates: pd.DataFrame, predicato, colonna: str = None) -> pd.DataFrame:
    """Filtra riga per riga aggirando un caso limite di pandas.

    Su un DataFrame vuoto .apply() restituisce una Series di dtype object,
    non bool: candidates[serie_non_booleana] non viene letto come maschera di
    righe ma come selezione di COLONNE, quindi il risultato perde tutte le
    colonne e il filtro successivo muore con KeyError sul nome della colonna.
    Con i filtri a catena qui sotto capita spesso che i candidati si esauriscano
    a metà strada, quindi il caso vuoto va intercettato prima.
    """
    if candidates.empty:
        return candidates
    if colonna is None:
        maschera = candidates.apply(predicato, axis=1)
    else:
        maschera = candidates[colonna].apply(predicato)
    return candidates[maschera.astype(bool)]


def candidates_for_slot(df: pd.DataFrame, slot: str, anchor_row: pd.Series, used_relpaths: set,
                         require_real_cluster: bool = False, current_items=None) -> pd.DataFrame:
    """require_real_cluster=True esclude i capi outlier (style_cluster=-1)
    dai candidati, anche se l'ancora stessa è un outlier. Usato per gli slot
    OPZIONALI (outerwear/accessorio): un capo "jolly" per debolezza di
    segnale (vedi style_match) può comunque superare la soglia di score
    puro — meglio quindi richiedere lì un'appartenenza di cluster reale e
    confermata, piuttosto che rischiare di aggiungere un pezzo stonato.
    Per gli slot obbligatori (top/bottom/scarpe) resta permissivo, perché
    il 44% del catalogo è outlier e negarli del tutto renderebbe molti
    outfit non completabili.

    current_items, se passato, applica anche il filtro di dispersione di
    formalità (vedi _formality_ok) e la coerenza stagionale manica/gamba
    (vedi _seasonal_coherence_ok) rispetto ai capi già scelti nell'outfit.
    """
    candidates = df[
        (df["slot"] == slot)
        & (~df["needs_vision_review"].astype(bool))
        & (~df["relpath"].isin(used_relpaths))
    ]
    if require_real_cluster:
        candidates = candidates[candidates["style_cluster"] != -1]
    candidates = _filtra(candidates, lambda g: _gender_compatible(g, anchor_row["gender"]), "gender")
    candidates = _filtra(candidates, lambda s: _season_compatible(s, anchor_row["season"]), "season")
    candidates = _filtra(candidates, lambda c: _cluster_compatible(c, anchor_row["style_cluster"]), "style_cluster")
    if current_items:
        # Genere e stagione vanno verificati contro TUTTI i capi già scelti, non
        # solo contro l'ancora: se l'ancora ha il valore indeterminato (None per
        # il genere, "tutte" per la stagione) è compatibile con chiunque, e due
        # capi incompatibili fra loro possono entrare entrambi passando ciascuno
        # il confronto con lei. Succedeva: 31 outfit mescolavano uomo e donna,
        # 138 mescolavano estate e inverno.
        candidates = _filtra(
            candidates,
            lambda g: all(_gender_compatible(g, r["gender"]) for _, r in current_items), "gender")
        candidates = _filtra(
            candidates,
            lambda s: all(_season_compatible(s, r["season"]) for _, r in current_items), "season")
        candidates = _filtra(candidates, lambda f: _formality_ok(current_items, f), "formality_norm")
        # su TUTTI gli slot, non più solo top/bottom: accessori e capospalla
        # erano l'unica via per cui un capo invernale entrava in un outfit estivo
        candidates = _filtra(candidates, lambda r: _seasonal_coherence_ok(current_items, slot, r))
        candidates = _filtra(candidates, lambda r: _calzatura_ok(current_items, slot, r))
        candidates = _filtra(candidates, lambda r: _cappotto_ok(current_items, slot, r))
    return candidates


def build_outfit(df: pd.DataFrame, anchor_relpath: str, w_colore: float = 0.5, w_stile: float = 0.5,
                  beam_width: int = 5, candidates_per_step: int = 30) -> dict:
    """Costruisce un outfit a partire da un capo ancora, via beam search
    slot per slot. Ritorna None se l'ancora non ha uno slot riconosciuto o
    se non si riesce a riempire tutti gli slot obbligatori."""
    anchor_rows = df[df["relpath"] == anchor_relpath]
    if anchor_rows.empty:
        return None
    anchor = anchor_rows.iloc[0]
    anchor_slot = anchor["slot"]
    if anchor_slot not in MANDATORY_SLOTS:
        return None

    remaining_mandatory = [s for s in MANDATORY_SLOTS if s != anchor_slot]

    # ogni elemento del beam: (lista di (slot, row), set di relpath già usati)
    beam = [([(anchor_slot, anchor)], {anchor_relpath})]

    def _min_pairwise(items):
        # stesso criterio del punteggio outfit finale (minimo, non media — vedi
        # docstring del modulo): la beam search deve ottimizzare l'anello più
        # debole, non farsi ingannare da una media alta durante la costruzione
        if len(items) < 2:
            return 1.0
        scores = [
            score_pair(items[i][1], items[j][1], w_colore, w_stile)["score"]
            for i in range(len(items)) for j in range(i + 1, len(items))
        ]
        return min(scores)

    for slot in remaining_mandatory:
        new_beam = []
        for items, used in beam:
            candidates = candidates_for_slot(df, slot, anchor, used, current_items=items)
            if candidates.empty:
                continue
            # per velocità, si pre-ordinano i candidati per score contro l'ancora
            # e se ne valutano approfonditamente (contro tutto il parziale) solo i migliori
            candidates = candidates.copy()
            candidates["_anchor_score"] = candidates.apply(
                lambda r: score_pair(anchor, r, w_colore, w_stile)["score"], axis=1
            )
            candidates = candidates.sort_values("_anchor_score", ascending=False).head(candidates_per_step)

            for _, cand in candidates.iterrows():
                new_items = items + [(slot, cand)]
                new_score = _min_pairwise(new_items)
                new_used = used | {cand["relpath"]}
                new_beam.append((new_items, new_used, new_score))

        if not new_beam:
            return None  # nessun candidato disponibile per questo slot -> outfit non completabile
        new_beam.sort(key=lambda t: t[2], reverse=True)
        beam = [(items, used) for items, used, _ in new_beam[:beam_width]]

    # slot obbligatori riempiti: proviamo ad aggiungere quelli opzionali al miglior candidato del beam
    best_items, best_used = beam[0]

    for slot in OPTIONAL_SLOTS:
        if slot == "outerwear" and not _outerwear_allowed(best_items):
            continue  # Regola 2: niente giacca/outerwear sui pantaloncini
        # Il cluster reale resta obbligatorio per il capospalla, dove un pezzo
        # stonato pesa su tutta la figura. Per gli accessori no: il 68% è
        # outlier — non perché sia sbagliato, ma perché borse e zaini hanno un
        # vettore di stile poco denso — e pretendere il cluster li escludeva in
        # blocco, comprese le borse street che devono poter comparire sugli
        # outfit street. A trattenere i pezzi fuori registro basta ora il
        # vincolo di formalità, che dopo la correzione del prior discrimina
        # davvero (prima due terzi del catalogo stavano sullo stesso valore).
        candidates = candidates_for_slot(df, slot, anchor, best_used,
                                          require_real_cluster=(slot == "outerwear"),
                                          current_items=best_items)
        if candidates.empty:
            continue
        candidates = candidates.copy()
        candidates["_score"] = candidates.apply(
            lambda r: _min_pairwise(best_items + [(slot, r)]), axis=1
        )
        best_candidate = candidates.loc[candidates["_score"].idxmax()]
        if best_candidate["_score"] >= OPTIONAL_SLOT_MIN_SCORE:
            best_items = best_items + [(slot, best_candidate)]
            best_used = best_used | {best_candidate["relpath"]}

    # punteggi pairwise finali, per trasparenza/debug
    pairwise_scores = {}
    for i in range(len(best_items)):
        for j in range(i + 1, len(best_items)):
            slot_i, row_i = best_items[i]
            slot_j, row_j = best_items[j]
            pairwise_scores[f"{slot_i}-{slot_j}"] = score_pair(row_i, row_j, w_colore, w_stile)["score"]

    outfit_score = min(pairwise_scores.values()) if pairwise_scores else 1.0

    slots_out = {slot: None for slot in MANDATORY_SLOTS + OPTIONAL_SLOTS}
    for slot, row in best_items:
        slots_out[slot] = {
            "relpath": row["relpath"],
            "title": row["title"],
            "url": row["url"],
            "display_image": row.get("display_image"),
            "all_images": row.get("all_images"),
        }

    return {"slots": slots_out, "pairwise_scores": {k: round(v, 3) for k, v in pairwise_scores.items()},
            "outfit_score": round(outfit_score, 3)}


def generate_outfits(df: pd.DataFrame, n_outfits: int = 10, anchor_slot: str = "top",
                      min_score: float = 0.6, w_colore: float = 0.5, w_stile: float = 0.5,
                      beam_width: int = 5, candidates_per_step: int = 30) -> list:
    """Genera outfit iterando i capi ancora dello slot indicato in ordine
    deterministico (per relpath — categoria/sottocategoria/slug), non via
    campionamento casuale: così nessun capo del catalogo viene escluso per
    sfortuna nel campionamento, e il risultato è riproducibile a parità di
    dati. Si ferma quando si raggiungono n_outfits outfit sopra min_score,
    o quando si esauriscono le ancore disponibili. Deduplica outfit
    identici (stesso insieme esatto di capi) che possono emergere da
    ancore diverse (es. l'outfit {A,B,C} può essere il migliore risultato
    sia partendo da A come ancora sia da B)."""
    anchor_pool = df[(df["slot"] == anchor_slot) & (~df["needs_vision_review"].astype(bool))]
    anchor_pool = anchor_pool.sort_values("relpath")

    outfits = []
    seen_signatures = set()
    for _, anchor in anchor_pool.iterrows():
        outfit = build_outfit(df, anchor["relpath"], w_colore, w_stile, beam_width, candidates_per_step)
        if not outfit or outfit["outfit_score"] < min_score:
            continue
        signature = frozenset(v["relpath"] for v in outfit["slots"].values() if v)
        if signature in seen_signatures:
            continue
        seen_signatures.add(signature)
        outfits.append(outfit)
        if len(outfits) >= n_outfits:
            break

    outfits.sort(key=lambda o: o["outfit_score"], reverse=True)
    return outfits


# =====================================================================
# Pipeline completa: pool di outfit per API/UI a valle
# =====================================================================

def build_garment_id(relpath: str) -> str:
    """Identificativo stabile e "pulito" per un capo, derivato da relpath
    via hash (non il path stesso) — pensato per un'API che non deve far
    trapelare la struttura di cartelle interna (es. /products/{id})."""
    return hashlib.sha256(relpath.encode("utf-8")).hexdigest()[:12]


def build_outfit_id(relpaths) -> str:
    """Identificativo stabile di un outfit, derivato dall'insieme (ordinato,
    per essere indipendente dall'ordine) dei relpath dei capi che lo
    compongono. Poiché la generazione è ora deterministica (vedi
    generate_outfits/run_outfit_pipeline), lo stesso outfit rigenerato in
    run successive ottiene sempre lo stesso id — utile per un'API/UI che
    debba referenziarlo nel tempo (es. outfit salvati/preferiti)."""
    signature = "|".join(sorted(relpaths))
    return hashlib.sha256(signature.encode("utf-8")).hexdigest()[:12]


def _serialize_slots(slots: dict) -> dict:
    out = {}
    for slot, item in slots.items():
        if item is None:
            out[slot] = None
            continue
        out[slot] = {
            "product_id": build_garment_id(item["relpath"]),
            "relpath": item["relpath"],
            "title": item["title"],
            "url": item["url"],
            "display_image": item.get("display_image"),
            # all_images arriva dal parquet come ndarray: "or []" su ndarray
            # solleva ValueError (verità ambigua), quindi il None si gestisce
            # esplicitamente prima di convertire in lista
            "all_images": [] if item.get("all_images") is None else list(item["all_images"]),
        }
    return out


_GENDER_LABEL = {"uomo": "uomo", "donna": "donna"}


def _build_outfit_label(gender, slots: dict) -> str:
    """Riga leggibile a colpo d'occhio, es. 'Outfit uomo: Camicia Nuvolari
    Petapa Sottobosco + Bermuda Nuvolari Zoe Verde Salvia + Sneakers
    Lacoste Elite Active' — pensata per scorrere il file JSONL senza dover
    aprire ogni oggetto slots per capire di che outfit si tratta."""
    gender_label = _GENDER_LABEL.get(gender, "unisex")
    parts = [item["title"] for item in slots.values() if item]
    return f"Outfit {gender_label}: " + " + ".join(parts)


def run_outfit_pipeline(df: pd.DataFrame, out_jsonl: str, min_score: float = 0.6,
                         w_colore: float = 0.5, w_stile: float = 0.5,
                         beam_width: int = 5, candidates_per_step: int = 30) -> dict:
    """Genera l'intero pool di outfit scansionando OGNI slot obbligatorio
    (top, bottom, scarpe) come ancora a turno — non solo "top" come fa
    generate_outfits di default — in ordine deterministico per relpath.
    Così ogni capo di ogni slot obbligatorio ha la sua possibilità di
    comparire in almeno un outfit, non solo i top (vedi discussione:
    ancorare solo dai top garantisce copertura ai top, non a bottom/scarpe,
    che potrebbero perdere sistematicamente come candidati senza mai
    essere loro stessi ancora).

    Deduplica GLOBALMENTE (stesso insieme esatto di capi trovato da ancore
    diverse — anche di slot diversi — conta una volta sola).

    Scrive incrementalmente su out_jsonl (un outfit per riga, JSONL) così
    il run lungo è resumibile/ispezionabile a metà. Formato di ogni riga
    pensato per essere consumato direttamente da un'API a valle: ogni capo
    ha un product_id stabile (hash di relpath, non il path stesso) e ogni
    outfit un outfit_id stabile (vedi build_garment_id/build_outfit_id) —
    lo stesso outfit rigenerato in run successive mantiene lo stesso id.
    """
    seen_signatures = set()
    total_anchors_tried = 0
    total_outfits_written = 0

    with open(out_jsonl, "w", encoding="utf-8") as f:
        for anchor_slot in MANDATORY_SLOTS:
            anchor_pool = df[(df["slot"] == anchor_slot) & (~df["needs_vision_review"].astype(bool))]
            anchor_pool = anchor_pool.sort_values("relpath")
            n = len(anchor_pool)
            print(f"[*] Slot ancora '{anchor_slot}': {n} candidati...", flush=True)

            for i, (_, anchor) in enumerate(anchor_pool.iterrows(), 1):
                total_anchors_tried += 1
                outfit = build_outfit(df, anchor["relpath"], w_colore, w_stile, beam_width, candidates_per_step)

                if i % 200 == 0 or i == n:
                    print(f"    [{anchor_slot} {i}/{n}] outfit unici finora: {total_outfits_written}", flush=True)

                if not outfit or outfit["outfit_score"] < min_score:
                    continue

                relpaths = [v["relpath"] for v in outfit["slots"].values() if v]
                signature = frozenset(relpaths)
                if signature in seen_signatures:
                    continue
                seen_signatures.add(signature)

                record = {
                    "outfit_id": build_outfit_id(relpaths),
                    "label": _build_outfit_label(anchor.get("gender"), outfit["slots"]),
                    "gender": anchor.get("gender"),
                    "outfit_score": outfit["outfit_score"],
                    "anchor_slot": anchor_slot,
                    "anchor_relpath": anchor["relpath"],
                    "slots": _serialize_slots(outfit["slots"]),
                    "pairwise_scores": outfit["pairwise_scores"],
                }
                f.write(json.dumps(record, ensure_ascii=False) + "\n")
                f.flush()
                total_outfits_written += 1

    stats = {
        "ancore_processate": total_anchors_tried,
        "outfit_unici_scritti": total_outfits_written,
        "output": out_jsonl,
    }
    print(f"\n[OK] Pipeline completata: {stats}", flush=True)
    return stats


print(
    "Modulo caricato (Fase 6 — generazione outfit). Esempio:\n"
    "df = load_and_prepare('/Users/enricociaralli/Desktop/nuvolari/features_clustered.parquet')\n"
    "outfits = generate_outfits(df, n_outfits=10)\n"
    "# oppure, per il pool completo (top/bottom/scarpe come ancora, JSONL):\n"
    "run_outfit_pipeline(df, out_jsonl='outfits_pool.jsonl')"
)
