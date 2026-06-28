import {
  BigNumberInput,
  PaymentAccountHolderDTO,
} from "@medusajs/framework/types";
import { BigNumber, MathBN } from "@medusajs/framework/utils";
import { PaymentIntentCreateParams, Stripe } from "stripe";
import { StripeOptions } from "../types";

// 零小数位货币（整数货币）
const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "JPY",
  "KMF",
  "KRW",
  "MGA",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);

// 三位小数货币
const THREE_DECIMAL_CURRENCIES = new Set([
  "BHD",
  "IQD",
  "JOD",
  "KWD",
  "OMR",
  "TND",
]);

function getCurrencyDecimalPlaces(currency: string): number {
  const upper = currency.toUpperCase();
  if (ZERO_DECIMAL_CURRENCIES.has(upper)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(upper)) return 3;
  return 2;
}

function getCurrencyMultiplier(currency: string): number {
  return Math.pow(10, getCurrencyDecimalPlaces(currency));
}

/**
 * 将金额转换为 Stripe 要求的最小货币单位整数。
 * 例：USD 1.99 → 199，JOD 1.999 → 2000（向上取整到十位），JPY 100 → 100
 * 参考：https://docs.stripe.com/currencies
 */
export function toStripeAmount(
  amount: BigNumberInput,
  currency: string,
): number {
  const multiplier = getCurrencyMultiplier(currency);
  const decimalPlaces = getCurrencyDecimalPlaces(currency);

  // 先把金额精度截断到该货币的小数位数，避免浮点误差
  const rounded = Math.round(
    new BigNumber(MathBN.mult(amount, multiplier)).numeric,
  );

  // 三位小数货币（如 KWD）需向上取整到十位
  // 原因：Stripe 对这类货币要求最小收费单位为 10（即 0.010）
  if (decimalPlaces === 3) {
    return Math.ceil(rounded / 10) * 10;
  }

  return rounded;
}

export function fromStripeAmount(
  amount: BigNumberInput,
  currency: string,
): number {
  const multiplier = getCurrencyMultiplier(currency);
  const standardAmount = new BigNumber(MathBN.div(amount, multiplier));
  return standardAmount.numeric;
}

// Parameters required for building Stripe's createOrder function. 
export const buildStripeParams = (
  options: StripeOptions,
  extra?: Record<string, unknown>,
): PaymentIntentCreateParams => {

  const amount = extra?.amount as BigNumberInput;
  const currency_code = extra?.currency_code as string;
  const session_id = extra?.session_id as string;
  const customer = (
    extra?.account_holder as PaymentAccountHolderDTO | undefined
  )?.data?.id as string | undefined;
  const metadata = extra?.metadata;
  const description = (extra?.payment_description ??
    options?.paymentDescription) as string;
  const capture_method =
    (extra?.capture_method as "automatic" | "manual") ??
    (options.capture ? "automatic" : "manual");
  const automatic_payment_methods =
    (extra?.automatic_payment_methods as { enabled: true } | undefined) ??
    (options?.automaticPaymentMethods ? { enabled: true } : undefined);
  const off_session = extra?.off_session as boolean | undefined
  const confirm = extra?.confirm as boolean | undefined
  const payment_method_options = extra?.payment_method_options as PaymentIntentCreateParams.PaymentMethodOptions
  const payment_method_types = extra?.payment_method_types as string[] | undefined
  const payment_method = extra?.payment_method as string | undefined
  const payment_method_data = extra?.payment_method_data as PaymentIntentCreateParams.PaymentMethodData | undefined
  const payment_method_configuration = 
    (extra?.payment_method_configuration as string | undefined)??
    (options.paymentMethodConfiguration as string | undefined);
  const setup_future_usage = extra?.setup_future_usage as
    | "off_session"
    | "on_session"
    | undefined;
  const return_url = extra?.return_url as string | undefined;

  return {
    amount: toStripeAmount(amount, currency_code),
    currency: currency_code,
    metadata: {
      ...(metadata || {}),
      session_id: session_id,
    },
    return_url,
    payment_method_configuration,
    payment_method_options,
    payment_method_types,
    payment_method_data,
    setup_future_usage,
    payment_method,
    confirm,
    off_session,
    automatic_payment_methods,
    capture_method,
    description,
    customer,
  };
};
