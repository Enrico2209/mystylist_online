import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { IconHanger2, IconX, IconCheck, IconExternalLink, IconLogout } from '@tabler/icons-react';
import { posta, prendi, leggiToken, leggiUtente, chiudiSessione, SessioneScaduta } from "./api.js";
import ModaleRifiuto from "./ModaleRifiuto.jsx";

const prezzo = (valore, completo) =>
    valore == null ? "—" :
    (completo ? "" : "da ") + valore.toLocaleString("it-IT",
        {style: "currency", currency: "EUR", maximumFractionDigits: 0});

function Dashboard(){

    const [revisionare, setRevisionare]= useState([]);
    const [giudicati, setGiudicati]= useState([]);
    const [statistiche, setStatistiche]= useState({totali:0, approvati:0, rifiutati:0, da_revisionare:0});
    const [errore, setErrore]= useState("");
    const [inCorso, setInCorso]= useState(false);
    const [modaleAperta, setModaleAperta]= useState(false);

    // Il codice esadecimale dell'outfit identifica il capo nel JSON,
    // l'intero id identifica la riga in matches: servono tutti e due.
    const [selezionato, setSelezionato]= useState(null);
    const [dettaglio, setDettaglio]= useState(null);

    const token = leggiToken();
    const utente = leggiUtente();
    const navigate= useNavigate();

    const esci = ()=>{ chiudiSessione(); navigate("/"); };

    // Arrivando su /dashboard senza token le chiamate tornerebbero tutte 401
    // e la pagina resterebbe vuota senza spiegare perché: meglio il login.
    useEffect(()=>{ if(!token) navigate("/"); },[token, navigate]);

    // Un token scaduto a metà revisione non è un guasto: si rifà l'accesso.
    const gestisciErrore = useCallback((e)=>{
        if(e instanceof SessioneScaduta) navigate("/");
        else setErrore(e.message);
    },[navigate]);

    const carica= useCallback(async()=>{
        try{
            // Niente iduser nel corpo: il server lo ricava dal token.
            const [coda, fatti, stat] = await Promise.all([
                posta("/api/revisionare", {}),
                posta("/api/giudicato", {}),
                posta("/api/statistiche", {}),
            ]);
            setRevisionare(coda);
            setGiudicati(fatti);
            setStatistiche(stat);
            setErrore("");
            // Tiene la selezione se l'outfit è ancora in coda, altrimenti
            // scende sul primo: dopo un giudizio la coda si accorcia.
            setSelezionato((corrente)=>
                coda.some((o)=>o.codice===corrente) ? corrente
                : (coda.length ? coda[0].codice : null));
        }catch(e){
            gestisciErrore(e);
        }
    },[gestisciErrore]);

    useEffect(()=>{ carica(); },[carica]);

    // La scheda completa (capi, prezzi, link) si carica solo per l'outfit
    // aperto: gli altri in lista hanno bisogno solo della miniatura.
    useEffect(()=>{
        if(!selezionato){ setDettaglio(null); return; }
        let annullato = false;
        prendi(`/api/outfit/${selezionato}`)
            .then((d)=>{ if(!annullato) setDettaglio(d); })
            .catch(()=>{});
        return ()=>{ annullato = true; };
    },[selezionato]);

    // Anche un outfit già giudicato si può riaprire: il verdetto si corregge,
    // /api/giudica aggiorna la riga invece di aggiungerne una seconda.
    const corrente = revisionare.find((o)=>o.codice===selezionato)
        || giudicati.find((o)=>o.codice===selezionato) || null;

    const giudica= useCallback(async(responso, commento, motivi)=>{
        if(!corrente || inCorso) return;
        setInCorso(true);
        try{
            await posta("/api/giudica",
                {id_match: corrente.id, responso, commento, motivi});
            setModaleAperta(false);
            await carica();
        }catch(e){
            gestisciErrore(e);
        }finally{
            setInCorso(false);
        }
    },[corrente, inCorso, carica, gestisciErrore]);

    // Le scorciatoie promesse dall'intestazione.
    useEffect(()=>{
        const tasto=(e)=>{
            // Con la modale aperta comanda lei: Esc e Cmd+Invio stanno lì.
            if(modaleAperta) return;
            if(e.target.tagName==="INPUT" || e.target.tagName==="TEXTAREA") return;
            const k = e.key.toLowerCase();
            // preventDefault anche sulle lettere: la modale mette il cursore
            // nel campo del commento prima che il tasto finisca di essere
            // battuto, e senza questo la "r" della scorciatoia si ritrova
            // scritta nel commento.
            if(k==="a"){ e.preventDefault(); giudica("si"); }
            else if(k==="r"){ e.preventDefault(); setModaleAperta(true); }
            else if(k==="arrowdown" || k==="arrowup"){
                e.preventDefault();
                const i = revisionare.findIndex((o)=>o.codice===selezionato);
                const j = Math.min(revisionare.length-1, Math.max(0, i + (k==="arrowdown"?1:-1)));
                if(revisionare[j]) setSelezionato(revisionare[j].codice);
            }
        };
        window.addEventListener("keydown", tasto);
        return ()=>window.removeEventListener("keydown", tasto);
        // modaleAperta va fra le dipendenze: senza, l'ascoltatore resta quello
        // registrato a modale chiusa e continua a leggere false, così premendo
        // A si approvava l'outfit mentre si stava scrivendo il motivo del
        // rifiuto.
    },[giudica, revisionare, selezionato, modaleAperta]);

    const scheda=(o, chiave, extra)=>(
        <div key={chiave} onClick={()=>o.codice && setSelezionato(o.codice)}
             className={`match-revisionato ${selezionato===o.codice ? "selezionato" : ""}`}>
            <div className="img-match">
                {o.miniatura
                    ? <img className="miniatura-outfit" src={o.miniatura} alt="" loading="lazy" decoding="async" />
                    : <IconHanger2 className="iconawardrobe" stroke={2} />}
            </div>
            <div className="match-testo">
                <div className="match-nome">{o.nome || `Match #${o.id}`}</div>
                <div className="match-dettagli">
                    {o.stile} · {o.genere} · {o.numero_capi} capi · {prezzo(o.prezzo_totale, o.prezzo_completo)}
                </div>
                {/* Solo sui revisionati: in coda questi campi non esistono. */}
                {o.motivi && o.motivi.length > 0 &&
                    <div className="match-motivi">
                        {o.motivi.map((m)=><span key={m} className="motivo-tag">{m}</span>)}
                    </div>}
                {o.commento && <div className="match-commento">“{o.commento}”</div>}
            </div>
            {extra}
        </div>
    );

    return(
        <>
            <div className="container-dashboard">
                <div className="header-dashboard">
                    <div className="header-dashboard-left">
                        <div className="header-logo"><strong>MYSTYLIST • </strong><span style={{fontStyle: "italic"}}>NUVOLARI</span></div>
                        <div className="header-subtitle">
                            {statistiche.totali} totali - {statistiche.approvati} approvati - {statistiche.rifiutati} rifiutati - {statistiche.da_revisionare} da revisionare
                        </div>
                    </div>
                    <div className="header-dashboard-right">
                        <div className="stylist-text">
                            {/* Il nome arriva dal token: scritto qui dentro,
                                chiunque accedesse vedeva il nome di un altro. */}
                            Stilista: <strong>{utente || "—"}</strong>
                            <span className="esci" onClick={esci} title="Esci">
                                <IconLogout size={13} stroke={2} /> Esci
                            </span>
                        </div>
                        <div className="shortcut-text">Shortcut <kbd>A</kbd> Approva <kbd>R</kbd> Rifiuta</div>
                    </div>

                </div>

                {errore && <div className="banner-errore">{errore}</div>}

                <div className="container-column-dashboard">

                    {/*Sezione di sinistra*/}
                    <div className="column-1">
                        <div className="daRevisionare-text">{revisionare.length} da Revisionare</div>
                        {revisionare.map((o)=>scheda(o, o.codice))}
                    </div>

                    {/*Sezione centrale*/}
                    <div className="column-2">
                        <div className="container-img-dashboard">
                            <div className="img-outfit">
                                {corrente
                                    ? <img className="foto-outfit" src={corrente.immagine} alt={corrente.nome} />
                                    : <IconHanger2 style={{color: "#E5E5E5", width:"70px", height: "70px"}} className="iconawardrobe" stroke={2} />}
                            </div>

                            {/* I capi che compongono l'outfit: è ciò su cui lo
                                stilista giudica, non solo la foto generata. */}
                            {dettaglio && corrente &&
                                <div className="striscia-capi">
                                    {dettaglio.capi.map((c)=>(
                                        <a key={c.id} className="capo" href={c.url_prodotto} target="_blank" rel="noreferrer">
                                            {c.immagine && <img src={c.immagine} alt="" loading="lazy" />}
                                            <div className="capo-testo">
                                                <div className="capo-slot">{c.slot_etichetta}</div>
                                                <div className="capo-brand">{c.brand || "—"}</div>
                                                <div className="capo-prezzo">
                                                    {c.prezzo == null ? "n.d." : prezzo(c.prezzo, true)}
                                                    <IconExternalLink size={13} stroke={2} />
                                                </div>
                                            </div>
                                        </a>
                                    ))}
                                </div>}

                            <div className="img-under">
                                <div className="nome-match-img-container">
                                    {corrente ? corrente.nome : "Nessun match da revisionare"}
                                </div>
                                {corrente &&
                                    <div className="riga-meta">
                                        <span>{corrente.stile}</span>
                                        <span>{corrente.genere}</span>
                                        <span>{prezzo(corrente.prezzo_totale, corrente.prezzo_completo)}</span>
                                        <span>compatibilità {Math.round(corrente.compatibilita*100)}%</span>
                                    </div>}
                                <div className="container-bottoni-tinder">
                                    <div className="rifiuta" onClick={()=>corrente && setModaleAperta(true)}><IconX stroke={2} />Rifiuta</div>
                                    <div className="approva" onClick={()=>giudica("si")}><IconCheck stroke={2} />Approva</div>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/*Sezione di destra*/}
                    <div className="column-3">
                        <div className="giudicati-text">{giudicati.length} Revisionati</div>
                        {giudicati.map((o)=>scheda(o, o.id,
                            <div className="esito" style={{
                                color: o.responso==="si" ? "#0B690A" : "#8E2727",
                                backgroundColor: o.responso==="si" ? "#73CB6D" : "#F09595"}}>
                                {o.responso==="si" ? <IconCheck stroke={2} /> : <IconX stroke={2} />}
                            </div>))}
                    </div>

                </div>
            </div>

            {modaleAperta && corrente &&
                <ModaleRifiuto outfit={corrente} inCorso={inCorso}
                               onAnnulla={()=>setModaleAperta(false)}
                               onConferma={(commento, motivi)=>giudica("no", commento, motivi)} />}

        </>
    );

}export default Dashboard;
