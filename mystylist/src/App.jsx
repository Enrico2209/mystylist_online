import {useEffect, useState} from "react";
import { Routes, Route, Navigate } from 'react-router-dom';
import Login from "./Login.jsx";
import Dashboard from "./Dashboard.jsx";
import "./App.css";
function App(){
    const [loggato, setLoggato] = useState(localStorage.getItem("logged"));
    return(
        
        <Routes>
            <Route path="/" element={<Login></Login>}></Route>
            <Route path="/dashboard" element={<Dashboard></Dashboard>}></Route>
        </Routes>
    );

}
export default App;