import { google } from "googleapis";
import readline from "readline";

const oauth2Client = new google.auth.OAuth2(
  "client-id",
  "client-secret",
  "urn:ietf:wg:oauth:2.0:oob",
);

const url = oauth2Client.generateAuthUrl({
  access_type: "offline",
  scope: ["https://www.googleapis.com/auth/spreadsheets"],
  prompt: "consent",
});

console.log("Open this link in your browser:\n", url);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

rl.question("\nEnter the code from the browser: ", async (code) => {
  try {
    const { tokens } = await oauth2Client.getToken(code.trim());
    console.log("\nAccess token:", tokens.access_token);
    console.log("Refresh token:", tokens.refresh_token);
  } catch (err) {
    console.error("Error retrieving tokens:", err);
  } finally {
    rl.close();
  }
});

