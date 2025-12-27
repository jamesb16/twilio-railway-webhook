const express = require("express");

const app = express();

// Twilio will POST form-encoded by default
app.use(express.urlencoded({ extended: false }));

app.get("/", (req, res) => res.status(200).send("OK"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

// Twilio Voice webhook
app.post("/voice", (req, res) => {
  res
    .type("text/xml")
    .send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Hello. Your Railway webhook is working.</Say>
</Response>`);
});

const PORT = Number(process.env.PORT) || 3000; // IMPORTANT
app.listen(PORT, "0.0.0.0", () => {
  console.log("Listening on", PORT);
});
