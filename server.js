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

// Dedup: track called numbers → timestamp (skip if called within 30 days)
const calledNumbers = new Map(); // normalizedPhone → Date
const DEDUP_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const CALL_DELAY_MS = 15 * 60 * 1000; // 15 minutes

// ============================================================
// SEQUENTIAL CALL QUEUE
// Only one call to Rob at a time. Next call fires after
// the current one completes (answered, skipped, or no answer).
// ============================================================
const callQueue = [];       // Array of { lead, fireTime }
let activeCallSid = null;   // Currently ringing/in-progress call
let processing = false;     // Lock to prevent double-processing

// 2-minute safety timeout — if Twilio status callback never fires,
// move on to the next call anyway
let safetyTimer = null;
const SAFETY_TIMEOUT_MS = 2 * 60 * 1000;

function enqueueCall(lead) {
  callQueue.push({ lead, queuedAt: new Date() });
  console.log(`[QUEUE] Added ${lead.name} (${lead.phone}) — ${callQueue.length} in queue`);
  processQueue();
}

async function processQueue() {
  if (processing || activeCallSid) return; // Already on a call
  if (callQueue.length === 0) return;      // Nothing to do

  processing = true;
  const { lead } = callQueue.shift();

  try {
    const call = await client.calls.create({
      to: ROB_CELL_NUMBER,
      from: TWILIO_PHONE_NUMBER,
      url: `${BASE_URL}/voice-connect`,
      method: "POST",
      statusCallback: `${BASE_URL}/call-status`,
      statusCallbackEvent: ["completed"],
      statusCallbackMethod: "POST",
    });

    activeCallSid = call.sid;
    pendingLeads.set(call.sid, lead);
    console.log(`[CALL] Initiated call ${call.sid} to Rob for lead: ${lead.name} (${lead.phone})`);

    // Safety timeout in case status callback never fires
    safetyTimer = setTimeout(() => {
      console.log(`[SAFETY] Timeout — clearing active call for ${lead.name}`);
      activeCallSid = null;
      processing = false;
      processQueue();
    }, SAFETY_TIMEOUT_MS);

  } catch (err) {
    console.error(`[ERROR] Twilio call failed for ${lead.name}:`, err.message);
    activeCallSid = null;
  }

  processing = false;
}

// ============================================================
// CALL STATUS CALLBACK — Twilio tells us the call is done
// ============================================================
app.post("/call-status", (req, res) => {
  const callSid = req.body.CallSid;
  const status = req.body.CallStatus; // completed, busy, no-answer, failed, canceled

  console.log(`[STATUS] Call ${callSid} ended with status: ${status}`);

  // Clear safety timer
  if (safetyTimer) {
    clearTimeout(safetyTimer);
    safetyTimer = null;
  }

  // Clean up
  pendingLeads.delete(callSid);
  activeCallSid = null;

  // Process next call in queue
  const remaining = callQueue.length;
  if (remaining > 0) {
    console.log(`[QUEUE] ${remaining} calls remaining — dialing next in 5 seconds`);
    setTimeout(() => processQueue(), 5000); // 5-second breather between calls
  }

  res.sendStatus(200);
});

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
  const pst = new Date(
    now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" })
  );
  const target = new Date(pst);
  target.setDate(target.getDate() + 1);
  target.setHours(targetHour, 0, 0, 0);
  return target.getTime() - pst.getTime();
}

// --- Dedup helpers ---
function normalizePhone(phone) {
  return (phone || "").replace(/\D/g, "");
}

function isDuplicate(phone) {
  const normalized = normalizePhone(phone);
  const lastCalled = calledNumbers.get(normalized);
  if (!lastCalled) return { duplicate: false };
  const elapsed = Date.now() - lastCalled.getTime();
  if (elapsed < DEDUP_WINDOW_MS) {
    const daysAgo = Math.floor(elapsed / (1000 * 60 * 60 * 24));
    return { duplicate: true, daysAgo };
  }
  return { duplicate: false };
}

function recordCall(phone) {
  calledNumbers.set(normalizePhone(phone), new Date());
}

// --- Cleanup expired dedup entries (runs every hour) ---
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [phone, date] of calledNumbers) {
    if (now - date.getTime() >= DEDUP_WINDOW_MS) {
      calledNumbers.delete(phone);
      cleaned++;
    }
  }
  if (cleaned > 0) console.log(`[CLEANUP] Removed ${cleaned} expired dedup entries`);
}, 60 * 60 * 1000);

// Morning queue — leads that came in after hours
const morningQueue = [];

function scheduleForMorning(lead) {
  const delay = msUntilNextMorning(10);
  const fireTime = new Date(Date.now() + delay);
  morningQueue.push({ lead, fireTime });

  console.log(`[QUEUED] ${lead.name} queued for 10am PST (fires at ${fireTime.toISOString()})`);

  setTimeout(() => {
    console.log(`[MORNING] Adding ${lead.name} to call queue`);
    enqueueCall(lead); // Goes into sequential queue, not direct dial
    const idx = morningQueue.findIndex((q) => q.lead === lead);
    if (idx !== -1) morningQueue.splice(idx, 1);
  }, delay);
}

// ============================================================
// 1. TRIGGER ENDPOINT — called by Make.com
// ============================================================
app.post("/trigger-call", async (req, res) => {
  const { name, phone, email } = req.body;

  if (!phone) {
    return res.status(400).json({ error: "Missing lead phone number" });
  }

  const lead = { name: name || "Unknown", phone, email };

  // --- Dedup check ---
  const { duplicate, daysAgo } = isDuplicate(phone);
  if (duplicate) {
    console.log(`[DEDUP] Skipping ${lead.name} (${phone}) — already called ${daysAgo} days ago`);
    return res.json({
      success: true,
      skipped: true,
      reason: `Already called ${daysAgo} days ago`,
    });
  }

  // Record IMMEDIATELY so subsequent triggers for the same number are blocked
  recordCall(phone);

  const fireTime = new Date(Date.now() + CALL_DELAY_MS);
  console.log(`[TRIGGER] New lead: ${lead.name} | ${phone} | Calling at ${fireTime.toISOString()}`);

  // Check business hours
  const futureHour = new Date(
    fireTime.toLocaleString("en-US", { timeZone: "America/Los_Angeles" })
  ).getHours();

  if (!isBusinessHours()) {
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
    scheduleForMorning(lead);
    return res.json({
      success: true,
      queued: true,
      reason: "Call would land after 6pm PST — queued for morning",
      scheduledFor: "10:00 AM PST tomorrow",
    });
  }

  // Schedule the call with 15-min delay, then into sequential queue
  setTimeout(() => {
    console.log(`[DELAYED] 15 min up — adding ${lead.name} to call queue`);
    enqueueCall(lead);
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

  res.type("text/xml");
  res.send(twiml.toString());
});

// ============================================================
// Queue inspection
// ============================================================
app.get("/queue", (req, res) => {
  res.json({
    currentPST: getPSTDate().toLocaleTimeString(),
    businessHours: isBusinessHours(),
    activeCall: activeCallSid
      ? { callSid: activeCallSid, lead: pendingLeads.get(activeCallSid) }
      : null,
    callQueue: callQueue.map((q) => ({
      name: q.lead.name,
      phone: q.lead.phone,
      queuedAt: q.queuedAt.toISOString(),
    })),
    queuedForMorning: morningQueue.map((q) => ({
      name: q.lead.name,
      phone: q.lead.phone,
      scheduledFor: q.fireTime.toISOString(),
    })),
    recentlyCalled: Array.from(calledNumbers.entries()).map(([phone, date]) => ({
      phone,
      calledAt: date.toISOString(),
      daysAgo: Math.floor((Date.now() - date.getTime()) / (1000 * 60 * 60 * 24)),
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
    activeCall: !!activeCallSid,
    callQueueLength: callQueue.length,
    queuedForMorning: morningQueue.length,
    trackedNumbers: calledNumbers.size,
  });
});

app.listen(PORT, () => {
  console.log(`Finlete Call Bot listening on port ${PORT}`);
});
