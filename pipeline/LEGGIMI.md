# pipeline — il codice che fabbrica gli outfit

Questa cartella non serve al deploy. Render costruisce solo da `server/` e da
`mystylist/`, e non guarda qui dentro. È qui per un motivo diverso: prima, il
codice che produce gli outfit esisteva **solo sul Mac di sviluppo**. Gli outfit
online erano al sicuro nel repository, la macchina che li produce no.

## Cosa c'è e cosa non c'è

Ci sono i sorgenti: scraping, estrazione delle caratteristiche, clustering,
punteggi, generazione del pool, generazione delle immagini, audit e i tre
script che portano tutto online.

Non ci sono i **dati**: niente foto del catalogo, niente `features_clustered.parquet`,
niente `outfits_pool.jsonl`, niente immagini generate. Sono decine di migliaia di
file e centinaia di MB, e la loro copia pubblicabile sta già in
`mystylist/public/media`. Non c'è nemmeno `.env`: le credenziali non entrano nel
repository, mai.

Vuol dire che questa cartella **non è eseguibile così com'è**: senza il catalogo
e senza i parquet gli script non hanno su cosa lavorare. È un archivio del
codice, non una seconda installazione.

## Da dove arriva

La copia di lavoro sta in `nuvolari backend/`, fuori da questo repository, ed è
quella che si modifica. `aggiorna_online.sh` ricopia i sorgenti qui a ogni
pubblicazione, quindi la cartella resta allineata da sé.

La direzione è una sola: **da `nuvolari backend/` verso `pipeline/`**. Modificare
un file qui dentro non ha effetto su niente e verrà sovrascritto alla prossima
pubblicazione.

## Da dove cominciare a leggere

`COME_NASCE_UN_OUTFIT.md` — spiega l'intero processo e ogni regola, con i valori
numerici e il difetto reale da cui ciascuna è nata. È il documento da leggere
per primo: gli altri file sono l'attuazione di quello.
