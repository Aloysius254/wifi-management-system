declare module 'africastalking' {
  interface SMSSendOptions {
    to: string[];
    message: string;
    from?: string;
  }
  interface SMSResult {
    SMSMessageData?: { Message: string; Recipients: any[] };
  }
  interface SMS {
    send(options: SMSSendOptions): Promise<SMSResult>;
  }
  interface ATInstance {
    SMS: SMS;
  }
  function AfricasTalking(options: { username: string; apiKey: string }): ATInstance;
  export = AfricasTalking;
}
