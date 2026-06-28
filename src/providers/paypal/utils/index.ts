import {
  BigNumberInput,
  PaymentAccountHolderDTO,
} from "@medusajs/framework/types";
import { BigNumber, MathBN } from "@medusajs/framework/utils";
import {
  CheckoutPaymentIntent,
  ItemRequest,
  OrderApplicationContextLandingPage,
  OrderApplicationContextUserAction,
  OrderRequest,
  ShippingDetails,
} from "@paypal/paypal-server-sdk";
import { PayPalOptions, PayPalWebhookEvent } from "../types";

/**
 * Parse the captured amount from the webhook event resource.
 * Falls back to 0 when the amount cannot be determined.
 */
export const resolveAmount = (event: PayPalWebhookEvent): BigNumber => {
  const value = event.resource.amount?.value;
  return new BigNumber(value ? parseFloat(value) : 0);
};

/**
 * Resolve the Medusa payment session_id from the webhook event.
 *
 * Strategy (in order of preference):
 * 1. `resource.custom_id`           — present on capture events when set
 * 2. `resource.purchase_units[0].custom_id` — present on order-approved events
 *
 * You must store the session_id in `purchase_units[].custom_id` when
 * creating the PayPal order via `initiatePayment`.
 */
export const resolveSessionId = (
  event: PayPalWebhookEvent,
): string | undefined => {
  const resource = event.resource;

  if (resource.custom_id) {
    return resource.custom_id;
  }

  const units = resource.purchase_units;
  if (units && units.length > 0 && units[0].custom_id) {
    return units[0].custom_id;
  }

  return undefined;
};

export const buildPayPalOrderParams = (
  options: PayPalOptions,
  extra?: Record<string, unknown>,
): OrderRequest => {

  const intent = options.autoCapture
      ? CheckoutPaymentIntent.Capture
      : CheckoutPaymentIntent.Authorize;

  // purchaseUnit
  const amount = extra?.amount as BigNumberInput;
  const currencyCode = extra?.currency_code as string;
  const softDescriptor = extra?.softDescriptor as string;
  const description =
    (extra?.payment_description as string | undefined) ??
    options?.paymentDescription;
  const customId = extra?.session_id as string | undefined;
  const invoiceId = extra?.invoiceId as string | undefined;
  const shipping = extra?.shipping as ShippingDetails | undefined;
  const items = extra?.items as ItemRequest[] | undefined

  // applicationContext
  const locale = extra?.locale as string | undefined;
  const brandName = extra?.brandName as string | undefined;
  const returnUrl = extra?.returnUrl as string | undefined;
  const cancelUrl = extra?.cancelUrl as string | undefined;

  return {
    intent,
    purchaseUnits: [
      {
        customId,
        description,
        amount: {
          currencyCode: currencyCode.toUpperCase(),
          value: amount.toString(),
        },
        invoiceId,
        shipping,
        softDescriptor,
        items
      },
    ],
    applicationContext: {
      brandName,
      locale,
      cancelUrl,
      returnUrl,
      landingPage: OrderApplicationContextLandingPage.NoPreference,
      userAction: OrderApplicationContextUserAction.PayNow,
    },
  };
};
