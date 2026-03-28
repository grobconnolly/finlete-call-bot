const express = require("express");
const twilio = require("twilio");
const VoiceResponse = twilio.twiml.VoiceResponse;

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Config from environment ---
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER, // Your Twilio number (caller ID)
  ROB_CELL_NUMBER,     // Your personal cell
  BASE_URL,            // Railway public URL, e.g. https://finlete-call-bot.up.railway.app
  PORT = 3000,
} = process.env;

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// In-memory store for pending leads (keyed by Twilio CallSid)
const pendingLeads = new Map();

// Queue for after-hours leads
const morningQueue = [];

// Queue for delayed leads (15-min wait)
const delayedLeads = [];

const CALL_DELAY_MS = 15 * 60 * 1000; // 15 minutes

// --- Time helpers (PST/PDT aware) ---
function getPSTDate() {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" })
  );
}

function isBusinessHours() {
  const now = getPSTDate();
  const hour = now.getHours();
  return hour >= 8 && hour < 18; // 8am - 6pm PST
}

function msUntilNextMorning(targetHour = 10) {
  const now = new Date();
  // Get current PST time
  const pst = new Date(
    now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" })
  );
  // Build target: next day at 10am PST
  const target = new Date(pst);
  target.setDate(target.getDate() + 1);
  target.setHours(targetHour, 0, 0, 0);
  // Calculate ms difference (account for UTC offset)
  const pstOffset = pst.getTime() - now.getTime();
  return target.getTime() - pst.getTime();
}

async function dialRob(lead) {
  try {
    const call = await client.calls.create({
      to: ROB_CELL_NUMBER,
      from: TWILIO_PHONE_NUMBER,
      url: `${BASE_URL}/voice-connect`,
      method: "POST",
    });

    pendingLeads.set(call.sid, lead);
    console.log(`[CALL] Initiated call ${call.sid} to Rob for lead: ${lead.name}`);
    return call.sid;
  } catch (err) {
    console.error("[ERROR] Twilio call failed:", err.message);
    throw err;
  }
}

function scheduleForMorning(lead) {
  const delay = msUntilNextMorning(10);
  const fireTime = new Date(Date.now() + delay);
  morningQueue.push({ lead, fireTime });

  console.log(`[QUEUED] ${lead.name} queued for 10am PST (fires at ${fireTime.toISOString()})`);

  setTimeout(async () => {
    console.log(`[MORNING] Firing queued call for ${lead.name}`);
    try {
      await dialRob(lead);
    } catch (err) {
      console.error(`[MORNING ERROR] Failed to call for ${lead.name}:`, err.message);
    }
    // Remove from queue
    const idx = morningQueue.findIndex((q) => q.lead === lead);
    if (idx !== -1) morningQueue.splice(idx, 1);
  }, delay);
}

// ============================================================
// 1. TRIGGER ENDPOINT — called by Make.com immediately
//    Server handles the 15-minute delay before calling Rob
// ============================================================
app.post("/trigger-call", async (req, res) => {
  const { name, phone, email } = req.body;

  if (!phone) {
    return res.status(400).json({ error: "Missing lead phone number" });
  }

  const lead = { name, phone, email };
  const fireTime = new Date(Date.now() + CALL_DELAY_MS);
  console.log(`[TRIGGER] New lead: ${name} | ${phone} | Calling at ${fireTime.toISOString()}`);

  // Check if call time (now + 15 min) will still be in business hours
  const futureHour = new Date(
    fireTime.toLocaleString("en-US", { timeZone: "America/Los_Angeles" })
  ).getHours();

  if (!isBusinessHours()) {
    // It's already after hours — queue for 10am
    scheduleForMorning(lead);
    const pstNow = getPSTDate();
    return res.json({
      success: true,
      queued: true,
      reason: `Outside business hours (current PST: ${pstNow.toLocaleTimeString()})`,
      scheduledFor: "10:00 AM PST tomorrow",
    });
  }

  if (futureHour >= 18) {
    // 15 min from now would be after 6pm — queue for morning
    scheduleForMorning(lead);
    return res.json({
      success: true,
      queued: true,
      reason: "Call would land after 6pm PST — queued for morning",
      scheduledFor: "10:00 AM PST tomorrow",
    });
  }

  // Schedule the call with 15-min delay
  delayedLeads.push({ lead, fireTime });

  setTimeout(async () => {
    console.log(`[DELAYED] 15 min up — calling Rob for ${lead.name}`);
    try {
      await dialRob(lead);
    } catch (err) {
      console.error(`[DELAYED ERROR] Failed to call for ${lead.name}:`, err.message);
    }
    // Remove from delayed queue
    const idx = delayedLeads.findIndex((d) => d.lead === lead);
    if (idx !== -1) delayedLeads.splice(idx, 1);
  }, CALL_DELAY_MS);

  res.json({
    success: true,
    delayed: true,
    callIn: "15 minutes",
    fireTime: fireTime.toISOString(),
  });
});

// ============================================================
// 2. VOICE CONNECT — TwiML served when Rob picks up
// ============================================================
app.post("/voice-connect", (req, res) => {
  const callSid = req.body.CallSid;
  const lead = pendingLeads.get(callSid);
  const leadName = lead?.name || "Unknown";

  const twiml = new VoiceResponse();

  const gather = twiml.gather({
    numDigits: 1,
    action: `${BASE_URL}/bridge-call`,
    method: "POST",
    timeout: 10,
  });

  gather.say(
    { voice: "Polly.Matthew", language: "en-US" },
    `New Finlete lead: ${leadName}. Press 1 to connect. Press 2 to skip.`
  );

  // If no input, hang up
  twiml.say("No input received. Goodbye.");

  res.type("text/xml");
  res.send(twiml.toString());
});

// ============================================================
// 3. BRIDGE CALL — dials the lead after Rob presses 1
// ============================================================
app.post("/bridge-call", (req, res) => {
  const callSid = req.body.CallSid;
  const digit = req.body.Digits;
  const lead = pendingLeads.get(callSid);

  const twiml = new VoiceResponse();

  if (digit === "1" && lead?.phone) {
    twiml.say(
      { voice: "Polly.Matthew" },
      `Connecting you to ${lead.name} now.`
    );
    twiml.dial(
      { callerId: TWILIO_PHONE_NUMBER, timeout: 30 },
      lead.phone
    );

    console.log(`[BRIDGE] Connecting Rob to ${lead.name} at ${lead.phone}`);
  } else {
    twiml.say("Skipped. Goodbye.");
    console.log(`[SKIP] Rob skipped lead: ${lead?.name}`);
  }

  // Clean up
  pendingLeads.delete(callSid);

  res.type("text/xml");
  res.send(twiml.toString());
});

// ============================================================
// Queue inspection — see what's waiting for morning
// ============================================================
app.get("/queue", (req, res) => {
  res.json({
    currentPST: getPSTDate().toLocaleTimeString(),
    businessHours: isBusinessHours(),
    delayedLeads: delayedLeads.map((d) => ({
      name: d.lead.name,
      phone: d.lead.phone,
      firesAt: d.fireTime.toISOString(),
    })),
    queuedForMorning: morningQueue.map((q) => ({
      name: q.lead.name,
      phone: q.lead.phone,
      scheduledFor: q.fireTime.toISOString(),
    })),
  });
});

// ============================================================
// Health check
// ============================================================
app.get("/", (req, res) => {
  res.json({
    status: "Finlete Call Bot running",
    currentPST: getPSTDate().toLocaleTimeString(),
    businessHours: isBusinessHours(),
    activeCalls: pendingLeads.size,
    delayedLeads: delayedLeads.length,
    queuedForMorning: morningQueue.length,
  });
});

app.listen(PORT, () => {
  console.log(`Finlete Call Bot listening on port ${PORT}`);
});
