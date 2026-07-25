// eslint-disable-next-line @typescript-eslint/no-require-imports
const AfricasTalking = require('africastalking');

function getSms() {
  const apiKey = process.env.AT_API_KEY;
  if (!apiKey) return null;
  const at = AfricasTalking({
    username: process.env.AT_USERNAME,
    apiKey,
  });
  return at.SMS;
}

export async function sendVoucherSMS(
  phone: string,
  code: string,
  roomNumber: string,
  durationHours: number,
  _guestPortalUrl: string,  // kept for API compatibility
  roomSsid?: string
): Promise<boolean> {
  const sms = getSms();
  if (!sms) {
    console.warn('[SMS] AT_API_KEY not set — SMS skipped');
    return false;
  }

  try {
    // Format phone number to E.164
    let formatted = phone.trim().replace(/\s+/g, '');
    if (formatted.startsWith('0')) {
      formatted = '+254' + formatted.slice(1); // Kenya
    } else if (!formatted.startsWith('+')) {
      formatted = '+' + formatted;
    }

    const ssid = roomSsid || process.env.WIFI_SSID || '';

    const message =
      `Hotel WiFi Access\n` +
      `Room: ${roomNumber}${ssid ? ` | WiFi: ${ssid}` : ''}\n` +
      `Duration: ${durationHours}hr\n` +
      `Your voucher code is: ${code}`;

    const sendOptions: Record<string, unknown> = {
      to: [formatted],
      message,
    };

    // Only use custom sender ID on live accounts (sandbox ignores it anyway)
    const senderId = process.env.AT_SENDER_ID;
    const username = process.env.AT_USERNAME || '';
    if (senderId && username !== 'sandbox') {
      sendOptions.from = senderId;
    }

    const result = await sms.send(sendOptions);
    const msgData = result.SMSMessageData;
    console.log('[SMS] Response:', JSON.stringify(msgData));
    
    // Check if any recipients were actually reached
    // AT success codes: 100 = Sent, 101 = Queued
    const recipients: any[] = msgData?.Recipients || [];
    const delivered = recipients.filter((r: any) => r.statusCode === 100 || r.statusCode === 101);
    if (delivered.length > 0) {
      console.log('[SMS] Sent to', formatted, msgData?.Message);
    } else if (recipients.length > 0) {
      const r = recipients[0];
      console.error(`[SMS] Delivery failed — statusCode: ${r.statusCode}, status: ${r.status}, number: ${r.number}`);
    } else {
      console.error('[SMS] No recipients in response:', msgData?.Message);
    }
    return delivered.length > 0;
  } catch (err: any) {
    if (err?.response) {
      console.error('[SMS] Failed — HTTP', err.response.status, err.response.statusText);
      console.error('[SMS] Response body:', JSON.stringify(err.response.data ?? err.response.body ?? ''));
    } else {
      console.error('[SMS] Failed:', err.message || err);
    }
    return false;
  }
}
