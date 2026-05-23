// eslint-disable-next-line @typescript-eslint/no-require-imports
const AfricasTalking = require('africastalking');

const at = AfricasTalking({
  username: process.env.AT_USERNAME || 'sandbox',
  apiKey: process.env.AT_API_KEY || '',
});

const sms = at.SMS;

export async function sendVoucherSMS(
  phone: string,
  code: string,
  roomNumber: string,
  durationHours: number,
  guestPortalUrl: string
): Promise<boolean> {
  try {
    // Format phone number to international format
    let formatted = phone.trim().replace(/\s+/g, '');
    if (formatted.startsWith('0')) {
      formatted = '+254' + formatted.slice(1); // Kenya
    } else if (!formatted.startsWith('+')) {
      formatted = '+' + formatted;
    }

    const message =
      `🏨 Hotel WiFi Access\n` +
      `Room: ${roomNumber}\n` +
      `Code: ${code}\n` +
      `Duration: ${durationHours} hour(s)\n` +
      `Connect at: ${guestPortalUrl}\n` +
      `Enter your code to get online.`;

    const result = await sms.send({
      to: [formatted],
      message,
    });

    console.log('[SMS] Sent to', formatted, result.SMSMessageData?.Message);
    return true;
  } catch (err: any) {
    console.error('[SMS] Failed:', err.message || err);
    return false;
  }
}
