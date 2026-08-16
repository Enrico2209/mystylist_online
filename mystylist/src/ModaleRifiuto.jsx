import { useEffect, useRef, useState } from "react";
import { IconX } from '@tabler/icons-react';

// Le voci ricalcano i modi in cui la pipeline sbaglia davvero: stagione,
// genere, formalità, colore. Spuntarle si conta, il testo libero no — ma
// serve per i casi che queste quattro non coprono.
const MOTIVI = [
    "Colori che stonano",
    "Stagione incoerente",
    "Genere sbagliato",
    "Formalità incoerente",
    "Capi che non stanno insieme",
    "Foto generata male",
];

function ModaleRifiuto({ outfit, onAnnulla, onConferma, inCorso }) {
    const [commento, setCommento] = useState("");
    const [motivi, setMotivi] = useState([]);
    const area = useRef(null);

    useEffect(()=>{ if(area.current) area.current.focus(); },[]);

    const conferma = () => onConferma(commento, motivi);

    const scorciatoie = (e) => {
        if (e.key === "Escape") onAnnulla();
        // Invio da solo va a capo nel testo: per confermare serve il modificatore.
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) conferma();
    };

    const alterna = (m) =>
        setMotivi((attuali)=> attuali.includes(m)
            ? attuali.filter((x)=>x!==m)
            : [...attuali, m]);

    return (
        <div className="velo-modale" onMouseDown={(e)=>{ if(e.target===e.currentTarget) onAnnulla(); }}>
            <div className="modale" onKeyDown={scorciatoie}>
                <div className="modale-testa">
                    <div>
                        <div className="modale-titolo">Perché lo rifiuti?</div>
                        <div className="modale-sottotitolo">
                            Scrivi cosa non ti convince: è quello che serve per correggere
                            l'algoritmo, il rifiuto da solo non dice dov'è l'errore.
                        </div>
                    </div>
                    <div className="modale-chiudi" onClick={onAnnulla}><IconX size={18} stroke={2} /></div>
                </div>

                {outfit &&
                    <div className="modale-outfit">
                        {outfit.miniatura && <img src={outfit.miniatura} alt="" />}
                        <div className="modale-outfit-nome">{outfit.nome}</div>
                    </div>}

                <div className="modale-motivi">
                    {MOTIVI.map((m)=>(
                        <div key={m} onClick={()=>alterna(m)}
                             className={`motivo ${motivi.includes(m) ? "motivo-scelto" : ""}`}>
                            {m}
                        </div>
                    ))}
                </div>

                <textarea ref={area} className="modale-commento" rows={4}
                          value={commento} onChange={(e)=>setCommento(e.target.value)}
                          placeholder="Es. la sciarpa non c'entra niente con i bermuda, e il marsupio Sprayground è troppo street per una camicia." />

                <div className="modale-bottoni">
                    <div className="modale-nota">Il commento è facoltativo · <kbd>Esc</kbd> annulla</div>
                    <div style={{display:"flex", gap:"10px"}}>
                        <div className="bottone-secondario" onClick={onAnnulla}>Annulla</div>
                        <div className={`rifiuta ${inCorso ? "disabilitato" : ""}`}
                             style={{width:"auto", padding:"0 22px"}}
                             onClick={()=>{ if(!inCorso) conferma(); }}>
                            <IconX stroke={2} />Rifiuta
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

export default ModaleRifiuto;
