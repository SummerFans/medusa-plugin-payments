# Medusa Plugin Payment

Stripe and PayPal payment modules and providers for Medusa v2 commerce frameworks.

## ⚠️ Warn

> | Requires Medusa v2.16.0 or later.

## Installation

```
npm i medusa-plugin-payments
```

## Configuration

```js
modules:[
{
      resolve: "@medusajs/medusa/payment",
      options: {
        providers: [
          {
            resolve: "medusa-plugin-payments/providers/stripe",
            options: {
              apiKey: process.env.STRIPE_API_KEY,
              webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
              capture:process.env.STRIPE_CAPTURE=='true'?true:false,
              automaticPaymentMethods:process.env.STRIPE_AUTOMATIC_PAYMENT_METHODS=='true'?true:false,
              paymentMethodConfiguration:process.env.STRIPE_PAYMENT_METHOD_CONFIGUR
            },
          },
          {
            resolve: "medusa-plugin-payments/providers/paypal",
            options: {
                sandbox: process.env.PAYPAL_SANDBOX,
                autoCapture:process.env.PAYPAL_AUTO_CAPTURE=='true'?true:false,
                clientId: process.env.PAYPAL_CLIENT_ID,
                clientSecret: process.env.PAYPAL_CLIENT_SECRET,
                webhookId: process.env.PAYPAL_WEBHOOK_ID
            },
          }
        ],
      },
    }
  ]
```


## Webhook Endpoint 
### Stripe: 
`https://{domain}/hooks/payment/stripe`
### Paypal: 
`https://{domain}/hooks/payment/paypal`
