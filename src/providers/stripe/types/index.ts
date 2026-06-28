export interface StripeOptions {
  /**
   * The API key for the Stripe account
   */
  apiKey: string;
  /**
   * The webhook secret used to verify webhooks
   */
  webhookSecret: string;
  /**
   * Use this flag to capture payment immediately (default is false)
   */
  capture?: string;
  /**
   * set `automatic_payment_methods` on the intent request to `{ enabled: true }`
   */
  automaticPaymentMethods?: boolean;
  /**
   * Set a default description on the intent if the context does not provide one
   */

  paymentMethodConfiguration?: string;

  paymentDescription?: string;
  /**
   * Set the number of days before an OXXO payment expires
   */
  oxxoExpiresDays?: number;
}

export const ErrorCodes = {
  PAYMENT_INTENT_UNEXPECTED_STATE: "payment_intent_unexpected_state",
  CHARGE_ALREADY_REFUNDED: "charge_already_refunded",
};

export const ErrorIntentStatus = {
  SUCCEEDED: "succeeded",
  CANCELED: "canceled",
}