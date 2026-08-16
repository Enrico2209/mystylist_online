import {useState} from "react";
import { useNavigate } from "react-router-dom";
import { posta, salvaSessione } from "./api.js";
import "./App.css";
function Login(){
    const [username, setUsername]= useState("");
    const [password, setPassword]= useState("");
    const [errore, setErrore]= useState("");
    const navigate= useNavigate();
    const accedi= async()=>{
        try{
            // Il login ora restituisce un token firmato: è quello che
            // autorizza le chiamate successive, non l'id utente.
            const data = await posta("/api/login", {username: username, password: password});
            // Prima si salva la sessione, poi si naviga: la dashboard la legge
            // appena si monta, e senza rimbalza qui.
            salvaSessione(data.token, data.utente);
            navigate("/dashboard");
        }catch(e){
            setErrore(e.message);
        }
    }
    return(
        <>
            <div className="mega-container-login">
                <div className="container">
                    <div className="login-logo"><strong>MYSTYLIST • </strong><span style={{fontStyle: "italic"}}>NUVOLARI</span></div>
                    <div className="login-title">Accedi alla revisione</div>
                    <div className="login-container">
                        <div className="username-text">Username</div>
                        <input className="box-username" onChange={(e)=>{setUsername(e.target.value)}}></input>
                        <div className="password-text">Password</div>
                        <input className="box-password" onChange={(e)=>{setPassword(e.target.value)}}></input>
                        <div className="password-dimenticata-text">Password dimenticata?</div>
                        {errore && <div className="banner-errore">{errore}</div>}
                        <div className="bottone-accedi" onClick={accedi}>Accedi</div>
                    </div>
                    <div className="reserved-text">Accesso riservato a stilisti e amministratori</div>

                </div>
            </div>

        </>
    
);


}
export default Login;