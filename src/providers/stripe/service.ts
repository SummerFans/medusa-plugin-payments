import { Logger } from "@medusajs/medusa";
import {
  isDefined,
  isPresent,
  MedusaError,
  PaymentActions,
  PaymentSessionStatus,
} from "@medusajs/framework/utils";
import { setTimeout } from "timers/promises";
import { AbstractPaymentProvider } from "@medusajs/framework/utils";
import Stripe from "stripe";
import { ErrorCodes, ErrorIntentStatus, StripeOptions } from "./types";
import {
  AuthorizePaymentInput,
  AuthorizePaymentOutput,
  CancelPaymentInput,
  CancelPaymentOutput,
  CapturePaymentInput,
  CapturePaymentOutput,
  DeletePaymentInput,
  DeletePaymentOutput,
  GetPaymentStatusInput,
  GetPaymentStatusOutput,
  InitiatePaymentInput,
  InitiatePaymentOutput,
  ProviderWebhookPayload,
  RefundPaymentInput,
  RefundPaymentOutput,
  RetrievePaymentInput,
  RetrievePaymentOutput,
  UpdatePaymentInput,
  UpdatePaymentOutput,
  WebhookActionResult,
} from "@medusajs/framework/types";
import { buildStripeParams, fromStripeAmount, toStripeAmount } from "./utils";
import { OrdersController } from "@paypal/paypal-server-sdk";

type InjectedDependencies = {
  logger: Logger;
};

class StripeProviderService extends AbstractPaymentProvider<StripeOptions> {
  protected logger_: Logger;
  protected options_: StripeOptions;
  protected stripe_: Stripe;

  static identifier = "stripe";

  static validateOptions(options: StripeOptions): void {
    if (!isDefined(options.apiKey)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Stripe API key is required",
      );
    }

    if (!isDefined(options.webhookSecret)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Stripe webhook secret is required",
      );
    }
  }

  constructor(container: InjectedDependencies, options: StripeOptions) {
    super(container, options);

    this.logger_ = container.logger;
    this.options_ = options;

    // TODO initialize your client
    this.stripe_ = new Stripe(options.apiKey);
  }

  private getStatus(paymentIntent: Stripe.PaymentIntent): {
    data: Stripe.PaymentIntent;
    status: PaymentSessionStatus;
  } {
    switch (paymentIntent.status) {
      case "requires_payment_method":
        if (paymentIntent.last_payment_error) {
          return { status: PaymentSessionStatus.ERROR, data: paymentIntent };
        }
        return { status: PaymentSessionStatus.PENDING, data: paymentIntent };
      case "requires_confirmation":
      case "processing":
        return { status: PaymentSessionStatus.PENDING, data: paymentIntent };
      case "requires_action":
        return {
          status: PaymentSessionStatus.REQUIRES_MORE,
          data: paymentIntent,
        };
      case "canceled":
        return { status: PaymentSessionStatus.CANCELED, data: paymentIntent };
      case "requires_capture":
        return { status: PaymentSessionStatus.AUTHORIZED, data: paymentIntent };
      case "succeeded":
        return { status: PaymentSessionStatus.CAPTURED, data: paymentIntent };
      default:
        return { status: PaymentSessionStatus.PENDING, data: paymentIntent };
    }
  }

  async getPaymentStatus({
    data,
    context,
  }: GetPaymentStatusInput): Promise<GetPaymentStatusOutput> {
    this.logger_.debug("[STRIPE]: GetPaymentStatus");

    const id = data?.id as string;
    if (!id) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "No payment intent ID provided while getting payment status",
      );
    }

    const paymentIntent = await this.stripe_.paymentIntents.retrieve(
      id,
      {},
      {
        idempotencyKey: context?.idempotency_key,
      },
    );

    this.logger_.debug("[STRIPE]: paymentIntent Params");
    this.logger_.debug(JSON.stringify(paymentIntent));

    const statusResponse = this.getStatus(paymentIntent);

    this.logger_.debug("[STRIPE]: statusResponse Params");
    this.logger_.debug(JSON.stringify(statusResponse));

    return statusResponse as unknown as GetPaymentStatusOutput;
  }

  async capturePayment({
    data,
    context,
  }: CapturePaymentInput): Promise<CapturePaymentOutput> {

    this.logger_.debug(`
      [STRIPE]: CapturePayment
      Data:
      ${JSON.stringify(data,null,2)}
      Context:
      ${JSON.stringify(context,null,2)}
      `)

    const id = data?.id as string;
    try {
      const paymentIntent = await this.stripe_.paymentIntents.capture(
        id,
        {},
        {
          idempotencyKey: context?.idempotency_key,
        },
      );
      return { data: paymentIntent as unknown as Record<string, unknown> };
    } catch (e: unknown) {
      if (!(e instanceof Stripe.errors.StripeError)) {
        // 非 Stripe 错误，直接抛出
        throw new MedusaError(
          MedusaError.Types.UNEXPECTED_STATE,
          e instanceof Error ? e.message : "An error occurred",
        );
      }

      if (e.code === "payment_intent_unexpected_state") {
        const status = (e as Stripe.errors.StripeInvalidRequestError)
          .payment_intent?.status;

        switch (status) {
          case ErrorIntentStatus.SUCCEEDED:
            // 已经被捕获过（幂等场景），视为成功
            return {
              data: (e as Stripe.errors.StripeInvalidRequestError)
                .payment_intent,
            };

          case ErrorIntentStatus.CANCELED:
            // 支付已取消，无法再捕获
            throw new MedusaError(
              e.type,
              `PaymentIntent ${id} has been canceled`,
            );
          default:
            // 其他非预期状态，抛出原始错误
            throw e;
        }
      }

      // 其他 Stripe 错误（网络、鉴权等），继续抛出
      throw e;
    }
  }

  async authorizePayment(
    input: AuthorizePaymentInput,
  ): Promise<AuthorizePaymentOutput> {
    this.logger_.debug("[STRIPE]: AuthorizePayment Params");
    this.logger_.debug(JSON.stringify(input));

    return this.getPaymentStatus(input);
  }

  async cancelPayment({
    data,
    context,
  }: CancelPaymentInput): Promise<CancelPaymentOutput> {

    this.logger_.debug(`[STRIPE]: CancelPayment \n    DATA: ${JSON.stringify(data,null,2)}\n   CONTEXT: ${JSON.stringify(context,null,2)}`)
    try {
      const id = data?.id as string;
      if (!id) {
        return { data: data };
      }
      const res = await this.stripe_.paymentIntents.cancel(
        id,
        {},
        {
          idempotencyKey: context?.idempotency_key,
        },
      );
      return { data: res as unknown as Record<string, unknown> };
    } catch (e: unknown) {
      if (!(e instanceof Stripe.errors.StripeInvalidRequestError)) {
        throw new MedusaError(
          MedusaError.Types.UNEXPECTED_STATE,
          e instanceof Error ? e.message : "An error occurred",
        );
      }
      if (e.payment_intent?.status === "canceled") {
        return { data: e.payment_intent };
      }
      throw e;
    }
  }

  async initiatePayment({
    currency_code,
    amount,
    data,
    context,
  }: InitiatePaymentInput): Promise<InitiatePaymentOutput> {
    const intentRequest = buildStripeParams(this.options_, {
      currency_code,
      amount,
      ...data,
      ...context,
    });

    this.logger_.debug("OPTIONS")
    this.logger_.debug(JSON.stringify(this.options_,null,2))
    this.logger_.debug("Stripe | initiatePayment Params");
    this.logger_.debug(JSON.stringify(intentRequest));

    const paymentIntent = await this.executeWithRetry<Stripe.PaymentIntent>(
      () =>
        this.stripe_.paymentIntents.create(intentRequest, {
          idempotencyKey: context?.idempotency_key,
        }),
    );

    const isPaymentIntent = "id" in paymentIntent;

    this.logger_.debug("Stripe | initiatePayment Result");
    this.logger_.debug(JSON.stringify(paymentIntent));

    return {
      id: isPaymentIntent ? paymentIntent.id : (data?.session_id as string),
      ...(this.getStatus(
        paymentIntent as unknown as Stripe.PaymentIntent,
      ) as unknown as Pick<InitiatePaymentOutput, "data" | "status">),
    } as InitiatePaymentOutput;
  }

  async deletePayment(input: DeletePaymentInput): Promise<DeletePaymentOutput> {
    return await this.cancelPayment(input);
  }

  async refundPayment({
    data,
    amount,
    context,
  }: RefundPaymentInput): Promise<RefundPaymentOutput> {
    const id = data?.id as string;

    this.logger_.debug("[STRIPE]: RefundPayment")
    this.logger_.debug("[STRIPE]: Amount:" + amount)
    this.logger_.debug(`[STRIPE]: DATA \n ${JSON.stringify(data,null,2)}`)
    this.logger_.debug(`[STRIPE]: Context\n ${JSON.stringify(context,null,2)}`)

    if (!id) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "No payment intent ID provided while refunding payment",
      );
    }

    try {
      const currencyCode = data?.currency as string;
      await this.stripe_.refunds.create(
        {
          amount: toStripeAmount(amount, currencyCode),
          payment_intent: id as string,
        },
        {
          idempotencyKey: context?.idempotency_key,
        },
      );
      return { data };
    } catch (e: unknown) {
      if (!(e instanceof Stripe.errors.StripeError)) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          e instanceof Error
            ? e.message
            : "An error occurred while refunding the payment.",
        );
      }
      throw new MedusaError(e.type, e.message);
    }
  }

  async retrievePayment({
    data,
    context,
  }: RetrievePaymentInput): Promise<RetrievePaymentOutput> {

     this.logger_.debug(`[STRIPE]: RetrievePayment\n    Data:\n ${JSON.stringify(data,null,2)} \n   Context:\n${JSON.stringify(context,null,2)}\n`)

    try {
      const id = data?.id as string;
      const intent = await this.stripe_.paymentIntents.retrieve(
        id,
        {},
        {
          idempotencyKey: context?.idempotency_key,
        },
      );

      intent.amount = fromStripeAmount(intent.amount, intent.currency);

      return { data: intent as unknown as Record<string, unknown> };
    } catch (e: unknown) {
      if (!(e instanceof Stripe.errors.StripeError)) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          e instanceof Error
            ? e.message
            : "An error occurred while retrieving the payment.",
        );
      }
      throw new MedusaError(e.type, e.message);
    }
  }

  async updatePayment({
    amount,
    currency_code,
    data,
    context,
  }: UpdatePaymentInput): Promise<UpdatePaymentOutput> {

    this.logger_.debug(`[STRIPE]: UpdatePayment\n   Amount:${amount.toString()}} ${currency_code}\n    Data:\n ${JSON.stringify(data,null,2)} \n   Context:\n${JSON.stringify(context,null,2)}\n`)

    const amountNumeric = toStripeAmount(amount, currency_code);
    if (isPresent(amount) && data?.amount === amountNumeric) {
      return this.getStatus(
        data as unknown as Stripe.PaymentIntent,
      ) as unknown as UpdatePaymentOutput;
    }

    try {
      const id = data?.id as string;
      const sessionData = (await this.stripe_.paymentIntents.update(
        id,
        {
          amount: amountNumeric,
        },
        {
          idempotencyKey: context?.idempotency_key,
        },
      )) as unknown as Record<string, unknown>;

      return this.getStatus(
        sessionData as unknown as Stripe.PaymentIntent,
      ) as unknown as UpdatePaymentOutput;
    } catch (e: unknown) {
      if (!(e instanceof Stripe.errors.StripeError)) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          e instanceof Error ? e.message : "An error occurred in updatePayment",
        );
      }
      throw new MedusaError(e.type, e.message);
    }
  }

  async getWebhookActionAndData(
    data: ProviderWebhookPayload["payload"],
  ): Promise<WebhookActionResult> {
    this.logger_.debug("[STRIPE]: getWebhookActionAndData");

    const signature = data.headers["stripe-signature"] as string;

    const event = this.stripe_.webhooks.constructEvent(
      data.rawData as string | Buffer,
      signature,
      this.options_.webhookSecret,
    );

    this.logger_.debug("[STRIPE] EVENT DATA");
    this.logger_.debug(JSON.stringify(event, null, 2));

    const intent = event.data.object as Stripe.PaymentIntent;

    const { currency } = intent;

    if (!intent.metadata?.session_id) {
      return { action: PaymentActions.NOT_SUPPORTED };
    }

    switch (event.type) {
      case "payment_intent.created":
      case "payment_intent.processing":
        return {
          action: PaymentActions.PENDING,
          data: {
            session_id: intent.metadata.session_id,
            amount: fromStripeAmount(intent.amount, currency),
          },
        };
      case "payment_intent.canceled":
        return {
          action: PaymentActions.CANCELED,
          data: {
            session_id: intent.metadata.session_id,
            amount: fromStripeAmount(intent.amount, currency),
          },
        };
      case "payment_intent.payment_failed":
        return {
          action: PaymentActions.FAILED,
          data: {
            session_id: intent.metadata.session_id,
            amount: fromStripeAmount(intent.amount, currency),
          },
        };
      case "payment_intent.requires_action":
        return {
          action: PaymentActions.REQUIRES_MORE,
          data: {
            session_id: intent.metadata.session_id,
            amount: fromStripeAmount(intent.amount, currency),
          },
        };
      case "payment_intent.amount_capturable_updated":
        return {
          action: PaymentActions.AUTHORIZED,
          data: {
            session_id: intent.metadata.session_id,
            amount: fromStripeAmount(intent.amount_capturable, currency),
          },
        };
      case "payment_intent.partially_funded":
        return {
          action: PaymentActions.REQUIRES_MORE,
          data: {
            session_id: intent.metadata.session_id,
            amount: fromStripeAmount(
              intent.next_action?.display_bank_transfer_instructions
                ?.amount_remaining ?? intent.amount,
              currency,
            ),
          },
        };
      case "payment_intent.succeeded":
        return {
          action: PaymentActions.SUCCESSFUL,
          data: {
            session_id: intent.metadata.session_id,
            amount: fromStripeAmount(intent.amount_received, currency),
          },
        };
      default:
        return { action: PaymentActions.NOT_SUPPORTED };
    }
  }

  // ---------Holder----------------

  //---------Other---------
  private handleStripeError(error: unknown):
    | { retry: true }
    | {
        retry: false;
        data: Stripe.PaymentIntent | { indeterminate_due_to: string };
      } {
    if (!(error instanceof Stripe.errors.StripeError)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        error instanceof Error ? error.message : "An error occurred",
      );
    }
    switch (error.type) {
      case "StripeCardError":
        const stripeError = error.raw as Stripe.errors.StripeCardError;
        if (stripeError.payment_intent) {
          return {
            retry: false,
            data: stripeError.payment_intent,
          };
        } else {
          throw new MedusaError(
            MedusaError.Types.INVALID_DATA,
            "An error occurred in InitiatePayment during creation of stripe payment intent",
          );
        }
      case "StripeConnectionError":
      case "StripeRateLimitError":
        return {
          retry: true,
        };
      case "StripePermissionError":
      case "StripeInvalidRequestError":
      case "StripeAuthenticationError":
      case "StripeAPIError": {
        this.logger_.error(`${error.name} | ${error.message}`);
        return {
          retry: false,
          data: {
            indeterminate_due_to: "stripe_api_error",
          },
        };
      }
      default:
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "An error occurred in InitiatePayment during creation of stripe payment intent",
        );
    }
  }

  private async executeWithRetry<T>(
    apiCall: () => Promise<T>,
    maxRetries: number = 3,
    baseDelay: number = 1000,
    currentAttempt: number = 1,
  ): Promise<T | Stripe.PaymentIntent | { indeterminate_due_to: string }> {
    try {
      return await apiCall();
    } catch (error: unknown) {
      const handledError = this.handleStripeError(error);
      if (!handledError.retry) {
        return handledError.data;
      }
      if (handledError.retry && currentAttempt <= maxRetries) {
        const delay =
          baseDelay *
          Math.pow(2, currentAttempt - 1) *
          (0.5 + Math.random() * 0.5);
        await setTimeout(delay);
        return this.executeWithRetry(
          apiCall,
          maxRetries,
          baseDelay,
          currentAttempt + 1,
        );
      }
      // Retries are exhausted
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `An error occurred in InitiatePayment during creation of stripe payment intent`,
      );
    }
  }
}

export default StripeProviderService;
