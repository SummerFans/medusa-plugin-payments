export interface PayPalOptions {
  sandbox: boolean;
  autoCapture:string;
  clientId: string;
  clientSecret: string;
  timeout?: number;
  webhookId: string;
  paymentDescription?: string;
  captureMethod?: "automatic" | "manual";
  setupFutureUsage?: "off_session" | "on_session";
  automaticPaymentMethods?: boolean;
  returnUrl?: string;
  cancelUrl?: string;
}


export interface PayPalWebhookVerifyPayload {
  auth_algo: string
  cert_url: string
  transmission_id: string
  transmission_sig: string
  transmission_time: string
  webhook_id: string
  webhook_event: object
}

export interface PayPalWebhookEvent {
  id: string
  event_type: string
  resource_type: string
  resource: {
    id: string
    amount?: {
      value: string
      currency_code: string
    }
    // supplementary_data is present on capture events
    supplementary_data?: {
      related_ids?: {
        order_id?: string
      }
    }
    // custom_id is present on order events and echoes back whatever
    // you put into purchase_units[].custom_id at order creation time.
    // We store the Medusa session_id there.
    purchase_units?: Array<{
      custom_id?: string
      payments?: {
        captures?: Array<{ id: string; custom_id?: string }>
      }
    }>
    custom_id?: string
  }
  summary?: string
}


export const PAYPAL_EVENTS = {
  // Buyer approved the order — funds not yet captured
  CHECKOUT_ORDER_APPROVED: "CHECKOUT.ORDER.APPROVED",
  // Capture succeeded — funds are in your account
  PAYMENT_CAPTURE_COMPLETED: "PAYMENT.CAPTURE.COMPLETED",
  // Capture is pending (e.g. eCheck, APM)
  PAYMENT_CAPTURE_PENDING: "PAYMENT.CAPTURE.PENDING",
  // Capture was denied
  PAYMENT_CAPTURE_DENIED: "PAYMENT.CAPTURE.DENIED",
  // Buyer-initiated or merchant-initiated refund
  PAYMENT_CAPTURE_REFUNDED: "PAYMENT.CAPTURE.REFUNDED",
  // Payment reversed / voided after approval but before capture
  CHECKOUT_PAYMENT_APPROVAL_REVERSED: "CHECKOUT.PAYMENT-APPROVAL.REVERSED",
} as const

