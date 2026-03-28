/**
 * omi-webhook — OMI Glass integration for Jack AI.
 * Receives conversation transcripts from OMI, processes with Claude,
 * and sends proactive notifications back to the glasses.
 *
 * Deployed on Mike's VPS (public IP + Nginx).
 * Nginx proxies /api/omi/* → localhost:3200
 */

import express from 'express';
import Anthropic from '@anthropic-ai/sdk';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.raw({ type: 'application/octet-stream', limit: '5mb' }));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const OMI_APP_ID = process.env.OMI_APP_ID || '';
const OMI_APP_SECRET = process.env.OMI_APP_SECRET || '';
const OWNER_UID = process.env.OMI_OWNER_UID || '';

// ── Jack's personality for OMI context ──────────────────────────────────────

const JACK_SYSTEM = `You are **Jack**, a personal AI assistant worn as glasses (OMI Glass) by Philip, founder of Aureus Automation in Singapore.

## Your Role
- You hear Philip's real-world conversations through the glasses microphone
- You process conversation transcripts and provide useful insights, reminders, and action items
- You are warm, clear, practical — no fluff, just useful help

## What You Do
- Extract action items and tasks from conversations
- Summarize key points and decisions
- Flag important follow-ups ("You mentioned calling Laura back tomorrow")
- Answer questions Philip asks aloud
- Help with business context: Aureus Automation runs a WhatsApp AI bot platform (SmartFAQ) and an AI personal assistant service (Aria AI)

## Behavior
- Keep responses SHORT — they're read on a small display or spoken aloud
- Max 2-3 sentences for notifications
- Use bullet points for action items
- Be proactive: if you spot something important, say it
- Don't repeat back the entire transcript — just give the insight

## Context
- Philip runs Aureus Automation Pte Ltd, Singapore
- Products: SmartFAQ Assistant (WhatsApp AI bots for SMEs) and Aria AI (personal AI assistant service)
- Key client: Laura Jiang / Pageant Lashes by Serenity Beaute
- Philip's role: CEO, handles sales, product, and technical development`;

// ── In-memory conversation context ──────────────────────────────────────────

const recentTranscripts = []; // last N transcripts for context
const MAX_CONTEXT = 10;

// ── Health check ────────────────────────────────────────────────────────────

app.get('/api/omi/health', (req, res) => {
  res.json({ ok: true, service: 'omi-webhook' });
});

// ── Setup completed check (OMI calls this) ──────────────────────────────────

app.get('/api/omi/setup', (req, res) => {
  res.json({ is_setup_completed: true });
});

// ── Memory Created Webhook ──────────────────────────────────────────────────
// OMI sends this when a conversation is fully processed

app.post('/api/omi/memory', async (req, res) => {
  res.status(200).send('ok'); // acknowledge immediately

  try {
    const memory = req.body;
    const uid = req.query.uid || OWNER_UID;

    if (!memory || memory.discarded) return;

    const transcript = memory.transcript_segments
      ?.map(s => `${s.is_user ? 'Philip' : (s.speaker_name || 'Other')}: ${s.text}`)
      .join('\n') || '';

    if (!transcript.trim()) return;

    console.log(`📱 OMI Memory: "${memory.structured?.title || 'Untitled'}" (${memory.transcript_segments?.length || 0} segments)`);

    // Store for context
    recentTranscripts.push({
      title: memory.structured?.title,
      overview: memory.structured?.overview,
      transcript: transcript.slice(0, 2000),
      timestamp: memory.created_at,
    });
    if (recentTranscripts.length > MAX_CONTEXT) recentTranscripts.shift();

    // Process with Claude
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: JACK_SYSTEM,
      messages: [{
        role: 'user',
        content: `A conversation just ended. Here's the transcript:\n\n${transcript}\n\n${memory.structured?.overview ? `OMI's summary: ${memory.structured.overview}` : ''}\n\nProvide any useful insights, action items, or follow-ups. If nothing notable, just say "Nothing to flag." Keep it brief.`,
      }],
    });

    const jackReply = response.content[0]?.text || '';
    console.log(`🤖 Jack says: "${jackReply.slice(0, 100)}..."`);

    // Only notify if there's something useful (skip "Nothing to flag")
    if (jackReply && !jackReply.toLowerCase().includes('nothing to flag') && !jackReply.toLowerCase().includes('nothing notable')) {
      await sendOmiNotification(uid, jackReply);
    }
  } catch (err) {
    console.error('OMI memory processing error:', err.message);
  }
});

// ── Real-Time Transcript Webhook ────────────────────────────────────────────
// OMI sends live transcript segments as the user speaks

app.post('/api/omi/transcript', async (req, res) => {
  res.status(200).send('ok'); // acknowledge immediately

  try {
    const segments = req.body;
    const sessionId = req.query.session_id;

    if (!Array.isArray(segments) || !segments.length) return;

    const text = segments.map(s => s.text).join(' ').trim();
    if (!text) return;

    console.log(`🎙 OMI Live: "${text.slice(0, 100)}..."`);

    // For real-time, we only respond if Philip directly asks a question
    const isQuestion = text.includes('?') ||
      /\b(hey jack|jack|what|how|when|where|who|can you|remind me|note that)\b/i.test(text);

    if (!isQuestion) return;

    // Build context from recent transcripts
    const context = recentTranscripts.length
      ? `Recent conversation context:\n${recentTranscripts.slice(-3).map(t => `- ${t.title}: ${t.overview || t.transcript.slice(0, 200)}`).join('\n')}\n\n`
      : '';

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: JACK_SYSTEM,
      messages: [{
        role: 'user',
        content: `${context}Philip just said (live): "${text}"\n\nIf he's asking you something or needs help, respond briefly. If it's just a conversation with someone else, say "SKIP".`,
      }],
    });

    const reply = response.content[0]?.text || '';
    if (reply && !reply.includes('SKIP')) {
      const uid = req.query.uid || OWNER_UID;
      await sendOmiNotification(uid, reply);
      console.log(`🤖 Jack (live): "${reply.slice(0, 100)}..."`);
    }
  } catch (err) {
    console.error('OMI transcript processing error:', err.message);
  }
});

// ── Audio Bytes Webhook (acknowledge only) ──────────────────────────────────

app.post('/api/omi/audio', (req, res) => {
  res.status(200).send('ok');
});

// ── Send notification to OMI glasses ────────────────────────────────────────

async function sendOmiNotification(uid, message) {
  if (!OMI_APP_ID || !OMI_APP_SECRET) {
    console.warn('⚠️ OMI_APP_ID or OMI_APP_SECRET not set — skipping notification');
    return;
  }

  try {
    const res = await fetch(`https://api.omi.me/v2/integrations/${OMI_APP_ID}/notification`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OMI_APP_SECRET}`,
      },
      body: JSON.stringify({
        uid,
        message,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`OMI notification failed (${res.status}): ${text}`);
    }
  } catch (err) {
    console.error('OMI notification error:', err.message);
  }
}

// ── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.OMI_PORT || 3200;
app.listen(PORT, () => {
  console.log(`🕶️  OMI Webhook running on port ${PORT}`);
  console.log(`   App ID: ${OMI_APP_ID || '(not set)'}`);
});
