import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { IconHanger2, IconX, IconCheck, IconArrowLeft, IconArrowBackUp } from '@tabler/icons-react';
import { posta, leggiToken, SessioneScaduta } from "./api.js";

const prezzo = (valore, completo) =>
    valore == null ? "—" :
    (completo ? "" : "da ") + valore.toLocaleString("it-IT",
        {style: "currency", currency: "EUR", maximumFractionDigits: 0});

// Gli outfit già giudicati stavano in una colonna della dashboard, larga il
// 30% e alta quanto lo schermo: con qualche centinaio di verdetti diventava
// uno scorrimento infinito accanto al lavoro vero. Qui hanno una pagina loro,
// a griglia, dove si cerca un outfit invece di scorrerlo.
function Revisionati(){

    const [giudicati, setGiudicati]= useState([]);
    const [errore, setErrore]= useState("");
    const [inCorso, setInCorso]= useState(false);
    const [caricato, setCaricato]= useState(false);
    const [aperto, setAperto]= useState(null);   // codice dell'outfit ingrandito
    const [filtro, setFiltro]= useState("tutti");

    const token = leggiToken();
    const navigate= useNavigate();

    useEffect(()=>{ if(!token) navigate("/"); },[token, navigate]);

    const gestisciErrore = useCallback((e)=>{
        if(e instanceof SessioneScaduta) navigate("/");
        else setErrore(e.message);
    },[navigate]);

    const carica= useCallback(async()=>{
        try{
            setGiudicati(await posta("/api/giudicato", {}));
            setErrore("");
        }catch(e){
            gestisciErrore(e);
        }finally{
            setCaricato(true);
        }
    },[gestisciErrore]);

    useEffect(()=>{ carica(); },[carica]);

    const visibili = giudicati.filter((o)=>
        filtro==="tutti" ? true : o.responso===(filtro==="approvati" ? "si" : "no"));

    const corrente = giudicati.find((o)=>o.codice===aperto) || null;

    // Toglie il verdetto e rimanda l'outfit nella coda generale. Chiude anche
    // l'ingrandimento: l'outfit non è più un revisionato, e lasciarlo aperto
    // mostrerebbe un esito che non esiste più.
    const rimetti= useCallback(async(o)=>{
        if(!o || inCorso) return;
        setInCorso(true);
        try{
            await posta("/api/annulla", {id_match: o.id});
            setAperto(null);
            await carica();
        }catch(e){
            gestisciErrore(e);
        }finally{
            setInCorso(false);
        }
    },[inCorso, carica, gestisciErrore]);

    // Esc chiude l'ingrandimento, come nella modale del rifiuto.
    useEffect(()=>{
        if(!aperto) return;
        const tasto=(e)=>{ if(e.key==="Escape") setAperto(null); };
        window.addEventListener("keydown", tasto);
        return ()=>window.removeEventListener("keydown", tasto);
    },[aperto]);

    const approvati = giudicati.filter((o)=>o.responso==="si").length;

    return(
        <>
            <div className="container-dashboard">
                <div className="header-dashboard">
                    <div className="header-dashboard-left">
                        <div className="header-logo"><strong>MYSTYLIST • </strong><span style={{fontStyle: "italic"}}>NUVOLARI</span></div>
                        <div className="header-subtitle">
                            {giudicati.length} revisionati - {approvati} approvati - {giudicati.length - approvati} rifiutati
                        </div>
                    </div>
                    <div className="header-dashboard-right">
                        <div className="bottone-pagina" onClick={()=>navigate("/dashboard")}>
                            <IconArrowLeft size={14} stroke={2} /> Torna alla revisione
                        </div>
                    </div>
                </div>

                {errore && <div className="banner-errore">{errore}</div>}

                <div className="filtri-revisionati">
                    {[["tutti","Tutti",giudicati.length],
                      ["approvati","Approvati",approvati],
                      ["rifiutati","Rifiutati",giudicati.length-approvati]].map(([k,etichetta,n])=>(
                        <div key={k} onClick={()=>setFiltro(k)}
                             className={`filtro ${filtro===k ? "filtro-scelto" : ""}`}>
                            {etichetta} <span className="filtro-numero">{n}</span>
                        </div>
                    ))}
                </div>

                <div className="griglia-revisionati">
                    {visibili.map((o)=>(
                        <div key={o.id} className="carta-revisionato" onClick={()=>setAperto(o.codice)}>
                            <div className="carta-img">
                                {o.miniatura
                                    ? <img src={o.miniatura} alt="" loading="lazy" decoding="async" />
                                    : <IconHanger2 className="iconawardrobe" stroke={2} />}
                                <div className="carta-esito" style={{
                                    color: o.responso==="si" ? "#0B690A" : "#8E2727",
                                    backgroundColor: o.responso==="si" ? "#73CB6D" : "#F09595"}}>
                                    {o.responso==="si" ? <IconCheck size={15} stroke={2} /> : <IconX size={15} stroke={2} />}
                                </div>
                            </div>
                            <div className="carta-nome">{o.nome || `Match #${o.id}`}</div>
                            <div className="carta-meta">
                                {o.stile} · {o.genere} · {prezzo(o.prezzo_totale, o.prezzo_completo)}
                            </div>
                            {o.motivi && o.motivi.length > 0 &&
                                <div className="match-motivi">
                                    {o.motivi.map((m)=><span key={m} className="motivo-tag">{m}</span>)}
                                </div>}
                        </div>
                    ))}
                    {caricato && !visibili.length &&
                        <div className="griglia-vuota">
                            {giudicati.length ? "Nessun outfit con questo filtro."
                                              : "Non hai ancora revisionato niente."}
                        </div>}
                </div>
            </div>

            {corrente &&
                <div className="velo-modale" onMouseDown={(e)=>{ if(e.target===e.currentTarget) setAperto(null); }}>
                    <div className="modale modale-ingrandita">
                        <div className="modale-testa">
                            <div>
                                <div className="modale-titolo">{corrente.nome}</div>
                                <div className="modale-sottotitolo">
                                    {corrente.stile} · {corrente.genere} · {corrente.numero_capi} capi ·{" "}
                                    {prezzo(corrente.prezzo_totale, corrente.prezzo_completo)} ·{" "}
                                    compatibilità {Math.round(corrente.compatibilita*100)}%
                                </div>
                            </div>
                            <div className="modale-chiudi" onClick={()=>setAperto(null)}><IconX size={18} stroke={2} /></div>
                        </div>

                        <div className="ingrandita-foto">
                            {corrente.immagine
                                ? <img src={corrente.immagine} alt={corrente.nome} />
                                : <IconHanger2 className="iconawardrobe" stroke={2} />}
                        </div>

                        <div className="riga-revisionato">
                            <span className={corrente.responso==="si" ? "esito-si" : "esito-no"}>
                                {corrente.responso==="si" ? "Approvato" : "Rifiutato"}
                            </span>
                            {corrente.motivi && corrente.motivi.length > 0 &&
                                corrente.motivi.map((m)=><span key={m} className="motivo-tag">{m}</span>)}
                            {corrente.commento && <span className="esito-commento">“{corrente.commento}”</span>}
                        </div>

                        <div className="modale-bottoni">
                            <div className="modale-nota"><kbd>Esc</kbd> chiude</div>
                            <div style={{display:"flex", gap:"10px"}}>
                                <div className="bottone-secondario" onClick={()=>setAperto(null)}>Chiudi</div>
                                <div className={`bottone-rimetti ${inCorso ? "disabilitato" : ""}`}
                                     onClick={()=>rimetti(corrente)}>
                                    <IconArrowBackUp size={16} stroke={2} /> Rimetti nella mischia
                                </div>
                            </div>
                        </div>
                    </div>
                </div>}
        </>
    );

}export default Revisionati;
