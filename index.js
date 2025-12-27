const express = require("express");

const app = express();

// Twilio sends x-www-form-urlencoded by default
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Root route so Railway URL doesn't look "dead"
app.get("/", (req, res) => res.status(200).send("OK"));

// Health check
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

// Twilio Voice webhook (POST)
app.post("/twilio/voice", (req, res) => {
  res.type("text/xml");
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Hello from Railway. Your webhook is working.</Say>
</Response>`);
});

// IMPORTANT: Railway decides the port. DO NOT hardcode 8080.
const PORT = process.env.PORT || 3000;
// IMPORTANT: bind to 0.0.0.0 in containers
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Listening on ${PORT}`);
});
