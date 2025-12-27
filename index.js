const express = require("express");
const app = express();

// Twilio sends form-encoded data by default
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true });
});

app.all("/twilio/voice", (req, res) => {
  // Minimal TwiML response (no AI, no extras)
  res.set("Content-Type", "text/xml");
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Hello. Your Railway webhook is working.</Say>
</Response>`);
});

// IMPORTANT: Railway provides the port in process.env.PORT
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Listening on", PORT);
});
