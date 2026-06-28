import {
  Client,
  LogLevel,
  Environment,
  CheckoutPaymentIntent,
  PaymentsController,
  OrdersController,
  Order as PaypalOrder,
  OrderStatus as PaypalOrderStatus,
  PatchOp,
  ApiError,
  OrderRequest,
  ApiResponse,
  PurchaseUnitRequest,
  Order,
} from "@paypal/paypal-server-sdk";
import { setTimeout } from "timers/promises";
import {
  PAYPAL_EVENTS,
  PayPalOptions,
  PayPalWebhookEvent,
  PayPalWebhookVerifyPayload,
} from "./types";
import {
  AbstractPaymentProvider,
  isDefined,
  BigNumber,
  MedusaError,
  PaymentSessionStatus,
  PaymentActions,
} from "@medusajs/framework/utils";

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
import { Logger } from "@medusajs/medusa";
import { buildPayPalOrderParams } from "./utils";

type InjectedDependencies = {
  logger: Logger;
};

class PaypalProviderService extends AbstractPaymentProvider<PayPalOptions> {
  static identifier = "paypal";

  protected logger_: Logger;
  protected options_: PayPalOptions;
  protected paypal_: Client;
  protected baseUrl_: string;

  static validateOptions(options: PayPalOptions): void {
    if (!isDefined(options.clientId)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_ARGUMENT,
        "Required option `clientId` is missing in PayPal plugin",
      );
    }
    if (!isDefined(options.clientSecret)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_ARGUMENT,
        "Required option `clientSecret` is missing in PayPal plugin",
      );
    }
    if (!isDefined(options.autoCapture)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_ARGUMENT,
        "Required option `intent` is missing in PayPal plugin",
      );
    }
    if (!isDefined(options.sandbox)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_ARGUMENT,
        "Required option `sandbox` is missing in PayPal plugin",
      );
    }
    if (!isDefined(options.webhookId)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_ARGUMENT,
        "Required option `webhookId` is missing in PayPal plugin",
      );
    }
  }

  constructor(container: InjectedDependencies, options: PayPalOptions) {
    super(container, options);

    this.options_ = options;
    this.logger_ = container.logger as Logger;

    this.baseUrl_ = options.sandbox
      ? "https://api-m.sandbox.paypal.com"
      : "https://api-m.paypal.com";

    this.paypal_ = new Client({
      clientCredentialsAuthCredentials: {
        oAuthClientId: this.options_.clientId,
        oAuthClientSecret: this.options_.clientSecret,
      },
      timeout: this.options_.timeout || 0,
      environment: this.options_.sandbox
        ? Environment.Sandbox
        : Environment.Production,
      logging: {
        logLevel: this.options_.sandbox ? LogLevel.Debug : LogLevel.Error,
        logRequest: {
          logBody: true,
        },
        logResponse: {
          logHeaders: true,
        },
      },
    });
  }

  private getStatus(paypalOrder: PaypalOrder): {
    data: PaypalOrder;
    status: PaymentSessionStatus;
  } {
    this.logger_.debug(`
    [PAYPAL]: GetStatus
    [PAYPAL]: PaypalOrder:
    ${JSON.stringify(paypalOrder, null, 2)}
      `);

    switch (paypalOrder.status) {
      // 1. 订单已创建，等待买家跳转 PayPal 进行操作
      case PaypalOrderStatus.Created:
        return {
          status: PaymentSessionStatus.PENDING,
          data: paypalOrder,
        };

      // 2. 订单已保存（通常用于已创建但尚未激活的引用交易）
      // 此时仍需等待买家后续操作，等同于待处理
      case PaypalOrderStatus.Saved:
        return {
          status: PaymentSessionStatus.PENDING,
          data: paypalOrder,
        };

      // 3. 需要买家在 PayPal 页面完成额外操作（如 3DS 验证或确认支付）
      case PaypalOrderStatus.PayerActionRequired:
        return {
          status: PaymentSessionStatus.REQUIRES_MORE,
          data: paypalOrder,
        };

      // 4. 买家已批准授权，资金已冻结（但尚未扣款）
      case PaypalOrderStatus.Approved:
        return {
          status: PaymentSessionStatus.AUTHORIZED,
          data: paypalOrder,
        };

      // 5. 资金已成功捕获并完成结算
      case PaypalOrderStatus.Completed:
        // 6. 资金已成功捕获并完成
        if (paypalOrder.intent == CheckoutPaymentIntent.Authorize) {
          return {
            status: PaymentSessionStatus.AUTHORIZED,
            data: paypalOrder,
          };
        }

        return {
          status: PaymentSessionStatus.CAPTURED,
          data: paypalOrder,
        };

      // 6. 订单已作废/取消
      case PaypalOrderStatus.Voided:
        return {
          status: PaymentSessionStatus.CANCELED,
          data: paypalOrder,
        };
      // 兜底逻辑：处理未知或意外的状态
      default:
        // 这里可以根据业务需求选择：
        // - 若认为未知状态应报错，可 throw new Error(...)
        // - 为了容错，降级为 PENDING 或 REQUIRES_MORE
        // 大部分情况下，将未预期状态映射为 PENDING 比较安全，避免中断支付流程
        return {
          status: PaymentSessionStatus.PENDING,
          data: paypalOrder,
        };
    }
  }

  async getPaymentStatus({
    data,
    context,
  }: GetPaymentStatusInput): Promise<GetPaymentStatusOutput> {
    this.logger_.debug(`
    [PAYPAL]: GetPaymentStatus\n
    [PAYPAL]: data:${JSON.stringify(data, null, 2)}\n
    [PAYPAL]: context:${JSON.stringify(context, null, 2)}\n
    `);

    const id = data?.id as string;
    if (!id) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "No payment intent ID provided while getting payment status",
      );
    }
    try {
      const ordersController = new OrdersController(this.paypal_);
      const retrievedPayment = await ordersController.getOrder({
        id,
      });

      if (!retrievedPayment || !retrievedPayment.result) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "An error occurred while retrieving the payment status",
        );
      }

      const paypalOrder = retrievedPayment.result as PaypalOrder;
      const statusResponse = this.getStatus(paypalOrder);

      return statusResponse as unknown as GetPaymentStatusOutput;
    } catch (e: unknown) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "No payment intent ID provided while getting payment status",
      );
    }
  }

  async capturePayment({
    data,
    context,
  }: CapturePaymentInput): Promise<CapturePaymentOutput> {
    this.logger_.debug(`
    [PAYPAL]: CapturePayment\n
    [PAYPAL]: data:${JSON.stringify(data, null, 2)}\n
    [PAYPAL]: context:${JSON.stringify(context, null, 2)}\n
      `);

    const order = data as Order;
    const authorization = order.purchaseUnits
      ?.at(0)
      ?.payments?.authorizations?.at(0);
    const authorizationId = authorization?.id as string;

    this.logger_.debug(`
    [PAYPAL]:Request Params
    ${JSON.stringify({
      paypalRequestId: context?.idempotency_key,
      authorizationId,
    })}
    `);

    try {
      const paymentsController = new PaymentsController(this.paypal_);
      const paypalOrder = await paymentsController.captureAuthorizedPayment({
        authorizationId,
        paypalRequestId: context?.idempotency_key,
      });

      this.logger_.debug(`
      [PAYPAL]: paypalOrder Data
      ${JSON.stringify(paypalOrder, null, 2)}
        `);

      return { data: paypalOrder.result as unknown as Record<string, unknown> };
    } catch (e: unknown) {
      console.error(e);
      if (!(e instanceof ApiError)) {
        // 非 Paypal 错误，直接抛出
        throw new MedusaError(
          MedusaError.Types.UNEXPECTED_STATE,
          e instanceof Error ? e.message : "An error occurred",
        );
      }

      throw new MedusaError(e.name, e.message);
    }
  }

  async authorizePayment({
    data,
    context,
  }: AuthorizePaymentInput): Promise<AuthorizePaymentOutput> {
    this.logger_.debug(`
      [PAYPAL]: AuthorizePayment\n
      [PAYPAL]: data:${JSON.stringify(data, null, 2)}\n
      [PAYPAL]: context:${JSON.stringify(context, null, 2)}\n
    `);

    return this.getPaymentStatus({
      data,
      context,
    });
  }

  async cancelPayment({
    data,
    context,
  }: CancelPaymentInput): Promise<CancelPaymentOutput> {
    this.logger_.debug(`
      [PAYPAL]: cancelPayment \n
      [PAYPAL]: data:${JSON.stringify(data, null, 2)}\n
      [PAYPAL]: context: ${JSON.stringify(context, null, 2)}\n
    `);

    if (!this.options_.autoCapture) {
      const order = data as Order;
      const authorizations =
        order.purchaseUnits?.[0]?.payments?.captures?.at(0);

      if (!authorizations) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "Could not find Authorizations to void",
        );
      }
      const authorizationId = authorizations?.id as string;

      const paymentsController = new PaymentsController(this.paypal_);
      paymentsController.voidPayment({
        authorizationId,
        prefer: "return=representation",
        paypalRequestId: context?.idempotency_key,
      });

      return { data };
    }

    return { data };
  }

  async initiatePayment({
    amount,
    currency_code,
    data,
    context,
  }: InitiatePaymentInput): Promise<InitiatePaymentOutput> {
    this.logger_.debug("Paypal: initiatePayment");
    const paypalBodyParams = buildPayPalOrderParams(this.options_, {
      amount,
      currency_code,
      ...data,
      ...context,
    });

    this.logger_.debug(`
    [PAYPAL]: InitiatePayment\n
    [PAYPAL]: Amount:${amount.toString()} | currency_code: ${currency_code}\n
    [PAYPAL]: Data:\n${JSON.stringify(data, null, 2)}\n
    [PAYPAL]: Context:\n${JSON.stringify(context, null, 2)}\n
    [PAYPAL]: PaypalBodyParams:\n${JSON.stringify(paypalBodyParams, null, 2)}\n
    [PAYPAL]: options:\n${JSON.stringify(this.options_, null, 2)}\n
      `);

    const ordersController = new OrdersController(this.paypal_);
    const paypalSessionData = (await this.executeWithRetry<
      ApiResponse<PaypalOrder>
    >(() =>
      ordersController.createOrder({
        paypalRequestId: context?.idempotency_key,
        body: paypalBodyParams,
        prefer: "return=representation",
      }),
    )) as ApiResponse<PaypalOrder>;

    const isPaypalOrder = "id" in paypalSessionData.result;

    this.logger_.debug("Paypal: paypalSessionData");
    this.logger_.debug(JSON.stringify(paypalSessionData));

    return {
      id: isPaypalOrder
        ? paypalSessionData.result.id
        : (data?.session_id as string),
      ...(this.getStatus(
        paypalSessionData.result as unknown as PaypalOrder,
      ) as unknown as Pick<InitiatePaymentOutput, "data" | "status">),
    } as InitiatePaymentOutput;
  }

  async deletePayment({
    data,
    context,
  }: DeletePaymentInput): Promise<DeletePaymentOutput> {
    this.logger_.debug(`
    [PAYPAL]: DeletePayment\n
    [PAYPAL]: Data: ${JSON.stringify(data, null, 2)}\n
    [PAYPAL]: Context: ${JSON.stringify(context, null, 2)}\n
      `);

    return await this.cancelPayment({
      data,
      context,
    });
  }

  async refundPayment({
    data,
    amount,
    context,
  }: RefundPaymentInput): Promise<RefundPaymentOutput> {
    this.logger_.debug(`
    [PAYPAL]: RefundPayment\n
    [PAYPAL]: Amount: ${amount.toString()}\
    [PAYPAL]: Data: ${JSON.stringify(data, null, 2)}\n
    [PAYPAL]: Context: ${JSON.stringify(context, null, 2)}\n
      `);

    try {
      const order = data as Order;

      let captureId;
      const refundRequest = {
        amount: {
          currencyCode: "",
          value: new BigNumber(amount).numeric.toString(),
        },
      };

      if (this.options_.autoCapture == "true") {
        // * CAPTURE
        const capture = order.purchaseUnits?.[0]?.payments?.captures?.at(0);
        if (!capture) {
          throw new MedusaError(
            MedusaError.Types.INVALID_DATA,
            "PayPal capture ID is required for refund",
          );
        }

        captureId = capture.id as string;
        refundRequest.amount.currencyCode = capture.amount
          ?.currencyCode as string;
      } else {

        this.logger_.debug(`
        [PAYPAL]: RefundPayment.AUTHORIZED
        [PAYPAL]: DATA\n${JSON.stringify(order, null, 2)}
        `)
        // * AUTHORIZED
        const authorization = order.purchaseUnits?.[0]?.payments?.authorizations?.at(0);
        if (!authorization) {
          throw new MedusaError(
            MedusaError.Types.INVALID_DATA,
            "PayPal authorization ID is required for refund",
          );
        }

        captureId=order.id;
        refundRequest.amount.currencyCode = authorization.amount
          ?.currencyCode as string;
      }

      if (!captureId || !refundRequest.amount.currencyCode) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "Missing PayPal capture ID",
        );
      }

      this.logger_.debug(`
        [PAYPAL]:Request Params
        ${JSON.stringify({
          paypalRequestId: context?.idempotency_key,
          captureId,
          body: refundRequest,
          prefer: "return=representation",
        })}
        `);

      const paymentsController = new PaymentsController(this.paypal_);
      await paymentsController.refundCapturedPayment({
        paypalRequestId: context?.idempotency_key,
        captureId,
        body: refundRequest,
        prefer: "return=representation",
      });

      return { data };
    } catch (e: unknown) {
      console.error(e);

      if (!(e instanceof ApiError)) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          e instanceof Error
            ? e.message
            : "An error occurred while refunding the payment.",
        );
      }
      throw new MedusaError(e.name, e.message);
    }
  }

  async retrievePayment({
    data,
    context,
  }: RetrievePaymentInput): Promise<RetrievePaymentOutput> {
    this.logger_.debug(`
    [PAYPAL]: RetrievePayment\n
    [PAYPAL]: Data: ${JSON.stringify(data, null, 2)}\n
    [PAYPAL]: Context: ${JSON.stringify(context, null, 2)}\n
      `);

    try {
      const id = data?.id as string;
      const ordersController = new OrdersController(this.paypal_);
      const paypalOrder = await ordersController.getOrder({
        id,
      });

      return { data: paypalOrder as unknown as Record<string, unknown> };
    } catch (e: unknown) {
      if (!(e instanceof ApiError)) {
        throw new MedusaError(
          MedusaError.Types.UNEXPECTED_STATE,
          "An error occurred in retrievePayment",
        );
      }
      throw new MedusaError(e.name, e.message);
    }
  }

  async updatePayment({
    amount,
    currency_code,
    data,
    context,
  }: UpdatePaymentInput): Promise<UpdatePaymentOutput> {
    this.logger_.debug(`
    [PAYPAL]: UpdatePayment\n
    [PAYPAL]: amount:${amount.toString()} | currency_code: ${currency_code}\n
    [PAYPAL]: Data: ${JSON.stringify(data, null, 2)}\n
    [PAYPAL]: Context: ${JSON.stringify(context, null, 2)}\n
      `);

    try {
      const id = data?.id as string;
      const ordersController = new OrdersController(this.paypal_);

      await ordersController.patchOrder({
        id,
        body: [
          {
            op: PatchOp.Replace,
            path: "/purchase_units/@reference_id=='default'/amount/value",
            value: {
              amount: {
                currencyCode: currency_code,
                value: new BigNumber(amount).numeric.toString(),
              },
            },
          },
        ],
      });

      return {
        data: {
          ...data,
          currency_code,
        },
      };
    } catch (e: unknown) {
      if (!(e instanceof ApiError)) {
        throw new MedusaError(
          MedusaError.Types.UNEXPECTED_STATE,
          "An error occurred in retrievePayment",
        );
      }
      throw new MedusaError(e.name, e.message);
    }
  }

  async getWebhookActionAndData(
    payload: ProviderWebhookPayload["payload"],
  ): Promise<WebhookActionResult> {
    try {
      const { data, rawData, headers } = payload;

      // Verify webhook signature
      const isValid = await this.verifyWebhookSignature(
        headers || {},
        data,
        rawData || "",
      );

      if (!isValid) {
        this.logger_.error("Invalid PayPal webhook signature");
        return {
          action: "failed",
          data: {
            session_id: "",
            amount: new BigNumber(0),
          },
        };
      }

      // PayPal webhook events have event_type
      const eventType = (data as any)?.event_type;

      if (!eventType) {
        this.logger_.warn("PayPal webhook event missing event_type");
        return {
          action: "not_supported",
          data: {
            session_id: "",
            amount: new BigNumber(0),
          },
        };
      }

      // Extract order ID and amount from webhook payload
      const resource = (data as any)?.resource;
      const sessionId: string | undefined = (data as any)?.resource?.custom_id;

      if (!sessionId) {
        this.logger_.warn("Session ID not found in PayPal webhook resource");
        return {
          action: "not_supported",
          data: {
            session_id: "",
            amount: new BigNumber(0),
          },
        };
      }

      const amountValue =
        resource?.amount?.value ||
        resource?.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value ||
        resource?.purchase_units?.[0]?.payments?.authorizations?.[0]?.amount
          ?.value ||
        0;

      const amount = new BigNumber(amountValue);
      const payloadData = {
        session_id: sessionId,
        amount,
      };

      this.logger_.debug(`
      [PAYPAL]: GetWebhookActionAndData\n
      [PAYPAL]: eventType: ${eventType}\n
      [PAYPAL]: PayloadData: ${JSON.stringify(payloadData, null, 2)}\n
        `);

      // Map PayPal webhook events to Medusa actions
      switch (eventType) {
        case "PAYMENT.AUTHORIZATION.CREATED":
          return {
            action: PaymentActions.AUTHORIZED,
            data: payloadData,
          };
        case "PAYMENT.CAPTURE.DENIED":
          return {
            action: PaymentActions.FAILED,
            data: payloadData,
          };

        case "PAYMENT.AUTHORIZATION.VOIDED":
          return {
            action: PaymentActions.CANCELED,
            data: payloadData,
          };

        case "PAYMENT.CAPTURE.COMPLETED":
          return {
            action: PaymentActions.SUCCESSFUL,
            data: payloadData,
          };
        default:
          this.logger_.warn(`Unhandled PayPal webhook event: ${eventType}`);
          return {
            action: PaymentActions.NOT_SUPPORTED,
            data: payloadData,
          };
      }
    } catch (error: any) {
      this.logger_.error(
        "PayPal getWebhookActionAndData error:",
        error.result?.message || error,
      );
      return {
        action: "failed",
        data: {
          session_id: "",
          amount: new BigNumber(0),
        },
      };
    }
  }

  // -----------Other------------------
  private handlePaypalError(error: unknown):
    | { retry: true }
    | {
        retry: false;
        data: ApiResponse<PaypalOrder> | { indeterminate_due_to: string };
      } {
    if (!(error instanceof ApiError)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        error instanceof Error ? error.message : "An error occurred",
      );
    }

    // 处理标准的 HTTP 状态码重试（500/503/429）
    if ([429, 500, 503].includes(error.statusCode)) {
      return {
        retry: true,
      };
    }

    return {
      retry: false,
      data: {
        indeterminate_due_to: "paypal_api_error",
      },
    };
  }

  private async executeWithRetry<T>(
    apiCall: () => Promise<T>,
    maxRetries: number = 3,
    baseDelay: number = 1000,
    currentAttempt: number = 1,
  ): Promise<T | ApiResponse<PaypalOrder> | { indeterminate_due_to: string }> {
    try {
      return await apiCall();
    } catch (error: unknown) {
      const handledError = this.handlePaypalError(error);
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
        `An error occurred in InitiatePayment during creation of paypal payment order`,
      );
    }
  }

  /**
   * Verify the webhook signature by posting back to PayPal's
   * verify-webhook-signature endpoint.
   *
   * NOTE: The raw request body **must** be forwarded byte-for-byte;
   * do not re-serialize the parsed JSON.
   */
  private async verifyWebhookSignature(
    headers: Record<string, any>,
    body: any,
    rawBody: string | Buffer | undefined,
  ): Promise<boolean> {
    try {
      if (!this.options_.webhookId) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "PayPal webhook ID is required for webhook signature verification",
        );
      }

      const transmissionId = headers["paypal-transmission-id"];
      const transmissionTime = headers["paypal-transmission-time"];
      const certUrl = headers["paypal-cert-url"];
      const authAlgo = headers["paypal-auth-algo"];
      const transmissionSig = headers["paypal-transmission-sig"];

      if (
        !transmissionId ||
        !transmissionTime ||
        !certUrl ||
        !authAlgo ||
        !transmissionSig
      ) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "Missing required PayPal webhook headers",
        );
      }

      // PayPal's API endpoint for webhook verification
      const baseUrl = !this.options_.sandbox
        ? "https://api.paypal.com"
        : "https://api.sandbox.paypal.com";

      const verifyUrl = `${baseUrl}/v1/notifications/verify-webhook-signature`;

      // Get access token for verification API call
      const authResponse = await fetch(`${baseUrl}/v1/oauth2/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${Buffer.from(
            `${this.options_.clientId}:${this.options_.clientSecret}`,
          ).toString("base64")}`,
        },
        body: "grant_type=client_credentials",
      });

      if (!authResponse.ok) {
        throw new MedusaError(
          MedusaError.Types.UNEXPECTED_STATE,
          "Failed to get access token for webhook verification",
        );
      }

      const authData = await authResponse.json();
      const accessToken = authData.access_token;

      if (!accessToken) {
        throw new MedusaError(
          MedusaError.Types.UNEXPECTED_STATE,
          "Access token not received from PayPal",
        );
      }

      let webhookEvent: any;
      if (rawBody) {
        const rawBodyString =
          typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
        try {
          webhookEvent = JSON.parse(rawBodyString);
        } catch (e) {
          this.logger_.warn("Raw body is not valid JSON, using parsed body");
          webhookEvent = body;
        }
      } else {
        this.logger_.warn(
          "Raw body not available, using parsed body. Verification may fail if formatting differs.",
        );
        webhookEvent = body;
      }

      const verifyPayload = {
        transmission_id: transmissionId,
        transmission_time: transmissionTime,
        cert_url: certUrl,
        auth_algo: authAlgo,
        transmission_sig: transmissionSig,
        webhook_id: this.options_.webhookId,
        webhook_event: webhookEvent,
      };

      const verifyResponse = await fetch(verifyUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(verifyPayload),
      });

      if (!verifyResponse.ok) {
        throw new MedusaError(
          MedusaError.Types.UNEXPECTED_STATE,
          "Webhook verification API call failed",
        );
      }

      const verifyData = await verifyResponse.json();

      // PayPal returns verification_status: "SUCCESS" if verification passes
      const isValid = verifyData.verification_status === "SUCCESS";

      if (!isValid) {
        throw new MedusaError(
          MedusaError.Types.UNEXPECTED_STATE,
          "Webhook signature verification failed",
        );
      }

      return isValid;
    } catch (e: unknown) {
      this.logger_.error("PayPal verifyWebhookSignature error:", e as Error);
      return false;
    }
  }
}

export default PaypalProviderService;
