import Stripe from 'stripe';
import { logger } from '../index.js';

export class StripeService {
  private stripe: Stripe;

  constructor() {
    const secretKey = process.env.STRIPE_SECRET_KEY;

    if (!secretKey) {
      logger.warn({ stripe: 'not_configured' }, 'Stripe not configured - payments will be limited');
      // Create a dummy client that will throw errors if used
      this.stripe = new Stripe('sk_dummy_key_for_incomplete_config', {
        apiVersion: '2024-11-20.acacia',
      });
    } else {
      this.stripe = new Stripe(secretKey, {
        apiVersion: '2024-11-20.acacia',
        typescript: true,
      });
      logger.info({ stripe: 'configured' }, 'Stripe service initialized');
    }
  }

  /**
   * Check if Stripe is properly configured
   */
  isConfigured(): boolean {
    return !!process.env.STRIPE_SECRET_KEY;
  }

  /**
   * Create a payment intent for an order
   */
  async createPaymentIntent(params: {
    amount: number; // Amount in cents
    currency?: string;
    metadata?: Record<string, string>;
    paymentMethodTypes?: string[];
    description?: string;
    receiptEmail?: string;
  }): Promise<{ clientSecret: string; paymentIntentId: string }> {
    if (!this.isConfigured()) {
      throw new Error('Stripe is not configured. Please add STRIPE_SECRET_KEY to environment.');
    }

    try {
      logger.info(
        {
          amount: params.amount,
          currency: params.currency || 'eur',
          metadata: params.metadata,
        },
        'Creating Stripe payment intent'
      );

      const paymentIntent = await this.stripe.paymentIntents.create({
        amount: params.amount,
        currency: params.currency || 'eur',
        metadata: params.metadata || {},
        payment_method_types: params.paymentMethodTypes || ['card'],
        description: params.description,
        receipt_email: params.receiptEmail,
        // Automatic payment methods for better mobile support
        automatic_payment_methods: {
          enabled: true,
        },
      });

      logger.info(
        {
          paymentIntentId: paymentIntent.id,
          amount: paymentIntent.amount,
          currency: paymentIntent.currency,
        },
        'Payment intent created successfully'
      );

      return {
        clientSecret: paymentIntent.client_secret as string,
        paymentIntentId: paymentIntent.id,
      };
    } catch (error: any) {
      logger.error({ error: error.message, stack: error.stack }, 'Failed to create payment intent');
      throw new Error(`Stripe payment intent creation failed: ${error.message}`);
    }
  }

  /**
   * Retrieve a payment intent
   */
  async getPaymentIntent(paymentIntentId: string): Promise<Stripe.PaymentIntent> {
    if (!this.isConfigured()) {
      throw new Error('Stripe is not configured');
    }

    try {
      const paymentIntent = await this.stripe.paymentIntents.retrieve(paymentIntentId);
      logger.info({ paymentIntentId, status: paymentIntent.status }, 'Retrieved payment intent');
      return paymentIntent;
    } catch (error: any) {
      logger.error({ error: error.message, paymentIntentId }, 'Failed to retrieve payment intent');
      throw error;
    }
  }

  /**
   * Confirm a payment intent (for server-side confirmation)
   */
  async confirmPaymentIntent(paymentIntentId: string): Promise<Stripe.PaymentIntent> {
    if (!this.isConfigured()) {
      throw new Error('Stripe is not configured');
    }

    try {
      const paymentIntent = await this.stripe.paymentIntents.confirm(paymentIntentId);
      logger.info({ paymentIntentId, status: paymentIntent.status }, 'Payment intent confirmed');
      return paymentIntent;
    } catch (error: any) {
      logger.error({ error: error.message, paymentIntentId }, 'Failed to confirm payment intent');
      throw error;
    }
  }

  /**
   * Cancel a payment intent
   */
  async cancelPaymentIntent(paymentIntentId: string): Promise<Stripe.PaymentIntent> {
    if (!this.isConfigured()) {
      throw new Error('Stripe is not configured');
    }

    try {
      const paymentIntent = await this.stripe.paymentIntents.cancel(paymentIntentId);
      logger.info({ paymentIntentId }, 'Payment intent cancelled');
      return paymentIntent;
    } catch (error: any) {
      logger.error({ error: error.message, paymentIntentId }, 'Failed to cancel payment intent');
      throw error;
    }
  }

  /**
   * Create a refund for a payment intent
   */
  async createRefund(params: {
    paymentIntentId: string;
    amount?: number; // Amount in cents, if not specified refunds full amount
    reason?: 'duplicate' | 'fraudulent' | 'requested_by_customer' | 'expired_authorization_card';
    metadata?: Record<string, string>;
  }): Promise<Stripe.Refund> {
    if (!this.isConfigured()) {
      throw new Error('Stripe is not configured');
    }

    try {
      const refund = await this.stripe.refunds.create({
        payment_intent: params.paymentIntentId,
        amount: params.amount,
        reason: params.reason || 'requested_by_customer',
        metadata: params.metadata,
      });

      logger.info(
        {
          refundId: refund.id,
          paymentIntentId: params.paymentIntentId,
          amount: refund.amount,
        },
        'Refund created successfully'
      );

      return refund;
    } catch (error: any) {
      logger.error({ error: error.message, paymentIntentId: params.paymentIntentId }, 'Failed to create refund');
      throw error;
    }
  }

  /**
   * Get Stripe publishable key for frontend
   */
  getPublishableKey(): string {
    const key = process.env.STRIPE_PUBLISHABLE_KEY || process.env.STRIPE_PUBLIC_KEY;

    if (!key) {
      logger.warn('Stripe publishable key not configured');
      return '';
    }

    return key;
  }

  /**
   * Create a setup intent for saving payment methods
   */
  async createSetupIntent(params: {
    customerId?: string;
    metadata?: Record<string, string>;
  }): Promise<{ clientSecret: string; setupIntentId: string }> {
    if (!this.isConfigured()) {
      throw new Error('Stripe is not configured');
    }

    try {
      const setupIntent = await this.stripe.setupIntents.create({
        customer: params.customerId,
        metadata: params.metadata,
        payment_method_types: ['card'],
      });

      logger.info({ setupIntentId: setupIntent.id }, 'Setup intent created');

      return {
        clientSecret: setupIntent.client_secret as string,
        setupIntentId: setupIntent.id,
      };
    } catch (error: any) {
      logger.error({ error: error.message }, 'Failed to create setup intent');
      throw error;
    }
  }

  /**
   * Create or retrieve a Stripe customer
   */
  async createOrRetrieveCustomer(params: {
    email: string;
    name?: string;
    phone?: string;
    metadata?: Record<string, string>;
  }): Promise<string> {
    if (!this.isConfigured()) {
      throw new Error('Stripe is not configured');
    }

    try {
      // First, try to find existing customer by email
      const existingCustomers = await this.stripe.customers.list({
        email: params.email,
        limit: 1,
      });

      if (existingCustomers.data.length > 0) {
        logger.info({ customerId: existingCustomers.data[0].id }, 'Found existing Stripe customer');
        return existingCustomers.data[0].id;
      }

      // Create new customer
      const customer = await this.stripe.customers.create({
        email: params.email,
        name: params.name,
        phone: params.phone,
        metadata: params.metadata,
      });

      logger.info({ customerId: customer.id }, 'Created new Stripe customer');
      return customer.id;
    } catch (error: any) {
      logger.error({ error: error.message, email: params.email }, 'Failed to create/retrieve customer');
      throw error;
    }
  }

  /**
   * Calculate Stripe fee for an amount
   * European Stripe: 1.4% + €0.25 per card payment
   */
  calculateStripeFee(amount: number): number {
    // Stripe fee for European cards: 1.4% + €0.25
    const percentageFee = amount * 0.014;
    const fixedFee = 25; // €0.25 in cents
    return Math.round(percentageFee + fixedFee);
  }

  /**
   * Verify webhook signature
   */
  constructWebhookEvent(payload: string, signature: string): Stripe.Event {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!webhookSecret) {
      throw new Error('Stripe webhook secret not configured');
    }

    try {
      const event = this.stripe.webhooks.constructEvent(payload, signature, webhookSecret);
      logger.info({ eventType: event.type }, 'Webhook signature verified');
      return event;
    } catch (error: any) {
      logger.error({ error: error.message }, 'Webhook signature verification failed');
      throw new Error('Invalid webhook signature');
    }
  }
}

// Export singleton instance
export const stripeService = new StripeService();
