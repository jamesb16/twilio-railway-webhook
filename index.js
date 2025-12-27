const express = require("express");
const app = express();

// Twilio sends application/x-www-form-urlencoded by default
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get("/", (req, res) => res.status(200).send("OK"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

// Twilio Voice webhook (set your number to POST here)
app.post("/twilio/voice", (req, res) => {
  res
    .type("text/xml")
    .send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Hello! Your Railway Twilio webhook is working.</Say>
</Response>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Listening on ${PORT}`);
});
