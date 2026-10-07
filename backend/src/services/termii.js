const axios = require('axios');

// Termii messaging integration for phone OTP delivery (spec §1, §6).
//
// We use Termii's regular SMS endpoint to DELIVER a code we generate and verify
// ourselves (see AuthController) — NOT Termii's managed Token API, which is not
// activated for our account's country. This module's only job is to send an SMS.
//
//   send -> POST {BASE}/api/sms/send -> { message_id, ... }
//
// TODO(sabipesin-credentials): both TERMII_API_KEY and TERMII_SENDER_ID are
// currently BORROWED from CraftRanked Nigeria Limited while SabiPesin Ltd's own
// Termii account clears CAC verification. Swap both back to SabiPesin's own
// approved credentials before launch — and note that as of 2026-08-25 even
// CraftRanked's "Craftranked" Sender ID is still PENDING approval, so live
// sends are blocked until an approved Sender ID exists on whichever account.

const {
    TERMII_API_KEY,
    TERMII_BASE_URL = 'https://api.ng.termii.com',
    // 'dnd' (with an approved Sender ID) is needed to reach DND-registered
    // numbers in production; 'generic' is fine otherwise.
    TERMII_CHANNEL = 'generic',
    // TODO(sabipesin-credentials): replace with SabiPesin's own approved Sender
    // ID once its Termii account is verified.
    TERMII_SENDER_ID = 'Craftranked',
} = process.env;

if (!TERMII_API_KEY) {
    throw new Error(
        'TERMII_API_KEY is not set. Copy .env.example to .env and provide the Termii API key.'
    );
}

// A Termii request that reaches the API but is rejected (bad key, unapproved
// sender, insufficient balance) surfaces as this error so callers can map it to
// an appropriate HTTP status.
class TermiiError extends Error {
    constructor(message, { status, data } = {}) {
        super(message);
        this.name = 'TermiiError';
        this.status = status;
        this.data = data;
    }
}

// Sends `text` as a plain SMS to `phone` (international format, no '+', e.g.
// 2348012345678). Returns Termii's message_id for auditing/traceability.
async function sendSms(phone, text) {
    let data;
    try {
        ({ data } = await axios.post(`${TERMII_BASE_URL}/api/sms/send`, {
            api_key: TERMII_API_KEY,
            to: phone,
            from: TERMII_SENDER_ID,
            sms: text,
            type: 'plain',
            channel: TERMII_CHANNEL,
        }));
    } catch (err) {
        if (err.response) {
            const { status, data: body } = err.response;
            const message = (body && (body.message || body.error)) || `Termii request failed (${status})`;
            throw new TermiiError(message, { status, data: body });
        }
        throw new TermiiError(`Could not reach Termii: ${err.message}`);
    }

    return { messageId: data.message_id, raw: data };
}

module.exports = {
    sendSms,
    TermiiError,
};
