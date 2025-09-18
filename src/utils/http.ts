import axios from "axios";


export const http = axios.create({
timeout: 20000,
headers: {
"User-Agent": "Mozilla/5.0",
Accept: "*/*"
},
validateStatus: s => s >= 200 && s < 300
});