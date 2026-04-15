import * as admin from 'firebase-admin';
import { onRequest, onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { setGlobalOptions } from 'firebase-functions/v2';
import { applyEscrowHoldInTransaction } from './payment/escrow';

setGlobalOptions({ region: 'europe-west1' });

admin.initializeApp();
const db = admin.firestore();

export { prepareShopierBatchOrders, createShopierCheckout, shopierWebhook } from './payment/shopierHandlers';
export {
  sendVerificationEmail,
  verifyEmailCode,
  resendVerificationEmail,
  sendPasswordResetEmail,
  verifyPasswordResetCode,
  checkEmailVerificationStatus,
  sendWelcomeEmail,
  testSMTPConnection,
} from './email';

// SSR for SEO
// export { ssr, botSsr } from './ssr';

// -----------------------------------------------------------------------------
// Mock Payment Intent + Webhook (provider erişimi gelene kadar)
// -----------------------------------------------------------------------------
export const createPaymentIntent = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required.');

  const { orderId, amountCents } = (request.data || {}) as { orderId?: string; amountCents?: number };
  if (!orderId || typeof orderId !== 'string') throw new HttpsError('invalid-argument', 'orderId required');
  if (!Number.isInteger(amountCents) || (amountCents as number) <= 0) throw new HttpsError('invalid-argument', 'amountCents must be positive int');
  const amountCentsNum = amountCents as number;

  const intentRef = db.collection('paymentIntents').doc();
  await intentRef.set({
    userId: uid,
    orderId,
    amount: amountCentsNum / 100,
    amountCents: amountCentsNum,
    currency: 'TRY',
    method: 'card',
    status: 'requires_action',
    provider: 'mock',
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  // mock yönlendirme linki (frontend bunu kullanıp "ödemeyi tamamla" simüle edebilir)
  return { intentId: intentRef.id };
}) as unknown as (request: CallableRequest) => Promise<{ intentId: string }>;

export const mockPaymentWebhook = onRequest(async (req: any, res: any) => {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
  const { intentId, status } = (req.body || {}) as { intentId?: string; status?: string };
  if (!intentId || typeof intentId !== 'string') return res.status(400).send('intentId required');
  if (!status || typeof status !== 'string') return res.status(400).send('status required');

  const intentRef = db.collection('paymentIntents').doc(intentId);
  const intentSnap = await intentRef.get();
  if (!intentSnap.exists) return res.status(404).send('intent not found');

  const intent = intentSnap.data() as any;
  const orderId = String(intent.orderId || '');
  if (!orderId) return res.status(400).send('intent missing orderId');

  // paid -> escrow hold
  if (status === 'captured') {
    await db.runTransaction(async (tx: FirebaseFirestore.Transaction) => {
      tx.update(intentRef, { status: 'captured', capturedAt: admin.firestore.FieldValue.serverTimestamp() });
      const orderRef = db.collection('orders').doc(orderId);
      const orderSnap = await tx.get(orderRef);
      if (!orderSnap.exists) throw new Error('order not found');
      const order = orderSnap.data() as any;
      if (order.buyerId !== intent.userId) throw new Error('buyer mismatch');

      tx.update(orderRef, {
        paymentStatus: 'captured',
        status: 'paid',
        escrowStatus: 'held',
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // hold funds for seller (held ledger)
      const sellerId = String(order.sellerId || '');
      const amountCents = Number(intent.amountCents || 0);
      if (!sellerId || !Number.isInteger(amountCents) || amountCents <= 0) throw new Error('invalid order');

      const sellerRef = db.collection('users').doc(sellerId);
      tx.set(
        sellerRef,
        {
          balanceHeldCents: admin.firestore.FieldValue.increment(amountCents)
        },
        { merge: true }
      );
    });
  } else if (status === 'failed') {
    await intentRef.update({ status: 'failed' });
  }

  return res.json({ ok: true });
});

export const mockCapturePayment = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required.');
  const { intentId } = (request.data || {}) as { intentId?: string };
  if (!intentId || typeof intentId !== 'string') throw new HttpsError('invalid-argument', 'intentId required');

  const intentRef = db.collection('paymentIntents').doc(intentId);

  await db.runTransaction(async (tx: FirebaseFirestore.Transaction) => {
    const intentSnap = await tx.get(intentRef);
    if (!intentSnap.exists) throw new HttpsError('not-found', 'intent not found');
    const intent = intentSnap.data() as any;
    if (intent.userId !== uid) throw new HttpsError('permission-denied', 'not owner');

    const orderId = String(intent.orderId || '');
    if (!orderId) throw new HttpsError('failed-precondition', 'intent missing orderId');

    const orderRef = db.collection('orders').doc(orderId);
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) throw new HttpsError('not-found', 'order not found');
    const order = orderSnap.data() as Record<string, unknown>;
    if (order.buyerId !== uid) throw new HttpsError('permission-denied', 'buyer mismatch');

    const amountCents = Number(intent.amountCents || order.amountCents || Math.round(Number(order.price || 0) * 100));
    const sellerId = String(order.sellerId || '');
    if (!sellerId || !Number.isInteger(amountCents) || amountCents <= 0) {
      throw new HttpsError('failed-precondition', 'invalid order');
    }

    applyEscrowHoldInTransaction(tx, db, {
      orderRef,
      order,
      buyerUserId: uid,
      amountCents,
      intentRef,
    });
  });

  return { status: 'captured' as const };
});

// -----------------------------------------------------------------------------
// Order actions: confirm delivery / dispute (client direct write yerine)
// -----------------------------------------------------------------------------
export const confirmDelivery = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required.');
  const { orderId } = (request.data || {}) as { orderId?: string };
  if (!orderId || typeof orderId !== 'string') throw new HttpsError('invalid-argument', 'orderId required');

  await db.runTransaction(async (tx: FirebaseFirestore.Transaction) => {
    const orderRef = db.collection('orders').doc(orderId);
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) throw new HttpsError('not-found', 'order not found');
    const order = orderSnap.data() as any;
    if (order.buyerId !== uid) throw new HttpsError('permission-denied', 'not buyer');
    if (order.status === 'disputed') throw new HttpsError('failed-precondition', 'order disputed');
    if (order.escrowStatus !== 'held') throw new HttpsError('failed-precondition', 'escrow not held');

    const sellerId = String(order.sellerId || '');
    const amountCents = Number(order.amountCents || Math.round(Number(order.price || 0) * 100));
    if (!sellerId || !Number.isInteger(amountCents) || amountCents <= 0) throw new HttpsError('failed-precondition', 'invalid order amount');

    const sellerRef = db.collection('users').doc(sellerId);
    tx.set(
      sellerRef,
      {
        balanceHeldCents: admin.firestore.FieldValue.increment(-amountCents),
        balanceAvailableCents: admin.firestore.FieldValue.increment(amountCents)
      },
      { merge: true }
    );

    tx.update(orderRef, {
      status: 'completed',
      escrowStatus: 'released',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      completedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    tx.set(db.collection('transactions').doc(), {
      userId: sellerId,
      type: 'escrow_release',
      amount: amountCents / 100,
      amountCents,
      direction: 'credit',
      refId: orderId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      meta: { buyerId: uid }
    });
  });

  return { ok: true };
});

export const openDispute = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required.');
  const { orderId, reason } = (request.data || {}) as { orderId?: string; reason?: string };
  if (!orderId || typeof orderId !== 'string') throw new HttpsError('invalid-argument', 'orderId required');

  await db.runTransaction(async (tx: FirebaseFirestore.Transaction) => {
    const orderRef = db.collection('orders').doc(orderId);
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) throw new HttpsError('not-found', 'order not found');
    const order = orderSnap.data() as any;

    const isBuyer = order.buyerId === uid;
    const isSeller = order.sellerId === uid;
    if (!isBuyer && !isSeller) throw new HttpsError('permission-denied', 'not participant');

    if (order.status === 'completed') throw new HttpsError('failed-precondition', 'order completed');

    tx.update(orderRef, {
      status: 'disputed',
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    tx.set(db.collection('disputes').doc(), {
      orderId,
      buyerId: order.buyerId,
      sellerId: order.sellerId,
      reason: String(reason || 'Uyuşmazlık bildirildi.'),
      status: 'open',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  });

  return { ok: true };
});

export const markDelivered = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required.');
  const { orderId } = (request.data || {}) as { orderId?: string };
  if (!orderId || typeof orderId !== 'string') throw new HttpsError('invalid-argument', 'orderId required');

  await db.runTransaction(async (tx: FirebaseFirestore.Transaction) => {
    const orderRef = db.collection('orders').doc(orderId);
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) throw new HttpsError('not-found', 'order not found');
    const order = orderSnap.data() as any;
    if (String(order.sellerId || '') !== uid) throw new HttpsError('permission-denied', 'not seller');
    if (order.status === 'disputed') throw new HttpsError('failed-precondition', 'order disputed');

    tx.update(orderRef, {
      status: 'delivered',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      deliveredAt: admin.firestore.FieldValue.serverTimestamp()
    });
  });

  return { ok: true };
});

// -----------------------------------------------------------------------------
// Trade System Actions
// -----------------------------------------------------------------------------
export const acceptTradeOffer = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required.');
  const { offerId } = (request.data || {}) as { offerId?: string };
  if (!offerId || typeof offerId !== 'string') throw new HttpsError('invalid-argument', 'offerId required');

  await db.runTransaction(async (tx: FirebaseFirestore.Transaction) => {
    const offerRef = db.collection('trade_offers').doc(offerId);
    const offerSnap = await tx.get(offerRef);
    if (!offerSnap.exists) throw new HttpsError('not-found', 'offer not found');
    const offer = offerSnap.data() as any;

    if (offer.receiverUserId !== uid) throw new HttpsError('permission-denied', 'not receiver');
    if (offer.status !== 'pending') throw new HttpsError('failed-precondition', 'offer not pending');

    // Update offer status
    tx.update(offerRef, {
      status: 'accepted',
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Log history
    const historyRef = db.collection('trade_status_history').doc();
    tx.set(historyRef, {
      offerId,
      oldStatus: 'pending',
      newStatus: 'accepted',
      changedBy: uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Lock both products
    const senderProductRef = db.collection('products').doc(offer.senderProductId);
    const receiverProductRef = db.collection('products').doc(offer.receiverProductId);

    tx.update(senderProductRef, {
      status: 'locked',
      lockedByTradeId: offerId,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    tx.update(receiverProductRef, {
      status: 'locked',
      lockedByTradeId: offerId,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Send notification to sender
    const notifRef = db.collection('notifications').doc();
    tx.set(notifRef, {
      userId: offer.senderUserId,
      type: 'info',
      title: 'Takas Teklifi Kabul Edildi!',
      message: 'Teklifiniz kabul edildi. İlgili ilanlar kilitlendi.',
      isRead: false,
      link: `/trade/offers/${offerId}`,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  });

  return { ok: true };
});

export const completeTradeOffer = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required.');
  const { offerId } = (request.data || {}) as { offerId?: string };
  if (!offerId || typeof offerId !== 'string') throw new HttpsError('invalid-argument', 'offerId required');

  await db.runTransaction(async (tx: FirebaseFirestore.Transaction) => {
    const offerRef = db.collection('trade_offers').doc(offerId);
    const offerSnap = await tx.get(offerRef);
    if (!offerSnap.exists) throw new HttpsError('not-found', 'offer not found');
    const offer = offerSnap.data() as any;

    const isSender = uid === offer.senderUserId;
    const isReceiver = uid === offer.receiverUserId;
    if (!isSender && !isReceiver) throw new HttpsError('permission-denied', 'not participant');
    if (offer.status !== 'accepted') throw new HttpsError('failed-precondition', 'offer not accepted');

    const update: any = {};
    if (isSender) update.senderConfirmed = true;
    else update.receiverConfirmed = true;

    tx.update(offerRef, {
      ...update,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Check if this action makes both confirmed
    const senderConfirmed = isSender ? true : offer.senderConfirmed;
    const receiverConfirmed = isReceiver ? true : offer.receiverConfirmed;

    if (senderConfirmed && receiverConfirmed) {
      tx.update(offerRef, {
        status: 'completed',
        completedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // Release cash if any
      if (offer.offeredCashAmount > 0) {
        const receiverRef = db.collection('users').doc(offer.receiverUserId);
        tx.update(receiverRef, {
          balance: admin.firestore.FieldValue.increment(offer.offeredCashAmount)
        });
        
        const txRef = db.collection('transactions').doc();
        tx.set(txRef, {
          userId: offer.receiverUserId,
          type: 'trade_income',
          amount: offer.offeredCashAmount,
          status: 'completed',
          relatedId: offerId,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }

      // Mark items as sold
      const senderProductRef = db.collection('products').doc(offer.senderProductId);
      const receiverProductRef = db.collection('products').doc(offer.receiverProductId);

      tx.update(senderProductRef, { status: 'sold' });
      tx.update(receiverProductRef, { status: 'sold' });

      // Notify both parties
      const notifSenderRef = db.collection('notifications').doc();
      tx.set(notifSenderRef, {
        userId: offer.senderUserId,
        type: 'success',
        title: 'Takas Tamamlandı!',
        message: 'Takas işlemi başarıyla tamamlandı.',
        isRead: false,
        link: `/trade/offers/${offerId}`,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      const notifReceiverRef = db.collection('notifications').doc();
      tx.set(notifReceiverRef, {
        userId: offer.receiverUserId,
        type: 'success',
        title: 'Takas Tamamlandı!',
        message: 'Takas işlemi başarıyla tamamlandı.',
        isRead: false,
        link: `/trade/offers/${offerId}`,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    // Log history
    const historyRef = db.collection('trade_status_history').doc();
    tx.set(historyRef, {
      tradeOfferId: offerId,
      oldStatus: offer.status,
      newStatus: (senderConfirmed && receiverConfirmed) ? 'completed' : offer.status,
      changedBy: uid,
      note: isSender ? 'Gönderici onayladı' : 'Alıcı onayladı',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  });

  return { ok: true };
});

export const payTradeCashDifference = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required.');
  const { offerId } = (request.data || {}) as { offerId?: string };
  if (!offerId || typeof offerId !== 'string') throw new HttpsError('invalid-argument', 'offerId required');

  await db.runTransaction(async (tx: FirebaseFirestore.Transaction) => {
    const offerRef = db.collection('trade_offers').doc(offerId);
    const offerSnap = await tx.get(offerRef);
    if (!offerSnap.exists) throw new HttpsError('not-found', 'offer not found');
    const offer = offerSnap.data() as any;

    if (offer.senderUserId !== uid) throw new HttpsError('permission-denied', 'not sender');
    if (offer.status !== 'accepted') throw new HttpsError('failed-precondition', 'offer not accepted');
    if (offer.cashPaid) throw new HttpsError('failed-precondition', 'cash already paid');
    if (!offer.offeredCashAmount || offer.offeredCashAmount <= 0) throw new HttpsError('failed-precondition', 'no cash to pay');

    const userRef = db.collection('users').doc(uid);
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) throw new HttpsError('not-found', 'user not found');
    const userData = userSnap.data() as any;

    if ((userData.balance || 0) < offer.offeredCashAmount) {
      throw new HttpsError('failed-precondition', 'insufficient-balance');
    }

    // Deduct balance
    tx.update(userRef, {
      balance: admin.firestore.FieldValue.increment(-offer.offeredCashAmount)
    });

    // Record transaction
    const txRef = db.collection('transactions').doc();
    tx.set(txRef, {
      userId: uid,
      type: 'trade_payment',
      amount: -offer.offeredCashAmount,
      status: 'completed',
      relatedId: offerId,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Update offer
    tx.update(offerRef, {
      cashPaid: true,
      cashPaidAt: admin.firestore.FieldValue.serverTimestamp()
    });
  });

  return { ok: true };
});

export const rejectTradeOffer = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required.');
  const { offerId } = (request.data || {}) as { offerId?: string };
  if (!offerId || typeof offerId !== 'string') throw new HttpsError('invalid-argument', 'offerId required');

  await db.runTransaction(async (tx: FirebaseFirestore.Transaction) => {
    const offerRef = db.collection('trade_offers').doc(offerId);
    const offerSnap = await tx.get(offerRef);
    if (!offerSnap.exists) throw new HttpsError('not-found', 'offer not found');
    const offer = offerSnap.data() as any;

    if (offer.receiverUserId !== uid) throw new HttpsError('permission-denied', 'not receiver');
    if (offer.status !== 'pending' && offer.status !== 'viewed') throw new HttpsError('failed-precondition', 'offer cannot be rejected');

    tx.update(offerRef, {
      status: 'rejected',
      lastActionBy: uid,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const historyRef = db.collection('trade_status_history').doc();
    tx.set(historyRef, {
      tradeOfferId: offerId,
      oldStatus: offer.status,
      newStatus: 'rejected',
      changedBy: uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const notifRef = db.collection('notifications').doc();
    tx.set(notifRef, {
      userId: offer.senderUserId,
      type: 'info',
      title: 'Takas Teklifi Reddedildi',
      message: 'Takas teklifiniz reddedildi.',
      isRead: false,
      link: `/trade/offers/${offerId}`,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  });

  return { ok: true };
});

export const cancelTradeOffer = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required.');
  const { offerId } = (request.data || {}) as { offerId?: string };
  if (!offerId || typeof offerId !== 'string') throw new HttpsError('invalid-argument', 'offerId required');

  await db.runTransaction(async (tx: FirebaseFirestore.Transaction) => {
    const offerRef = db.collection('trade_offers').doc(offerId);
    const offerSnap = await tx.get(offerRef);
    if (!offerSnap.exists) throw new HttpsError('not-found', 'offer not found');
    const offer = offerSnap.data() as any;

    if (offer.senderUserId !== uid) throw new HttpsError('permission-denied', 'not sender');
    if (offer.status !== 'pending' && offer.status !== 'viewed') throw new HttpsError('failed-precondition', 'offer cannot be cancelled');

    tx.update(offerRef, {
      status: 'cancelled',
      lastActionBy: uid,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const historyRef = db.collection('trade_status_history').doc();
    tx.set(historyRef, {
      tradeOfferId: offerId,
      oldStatus: offer.status,
      newStatus: 'cancelled',
      changedBy: uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const notifRef = db.collection('notifications').doc();
    tx.set(notifRef, {
      userId: offer.receiverUserId,
      type: 'info',
      title: 'Takas Teklifi İptal Edildi',
      message: 'Karşı taraf takas teklifini iptal etti.',
      isRead: false,
      link: `/trade/offers/${offerId}`,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  });

  return { ok: true };
});

export const createTradeOffer = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required.');
  
  const { targetListingId, offeredListingIds, cashOffer, message, counterOfferId } = request.data;
  
  if (!targetListingId) throw new HttpsError('invalid-argument', 'targetListingId required');

  let newOfferId = '';

  await db.runTransaction(async (tx: FirebaseFirestore.Transaction) => {
    const targetRef = db.collection('products').doc(targetListingId);
    const targetSnap = await tx.get(targetRef);
    if (!targetSnap.exists) throw new HttpsError('not-found', 'target listing not found');
    const target = targetSnap.data() as any;

    if (!target.isTradeAllowed) throw new HttpsError('failed-precondition', 'trade not allowed');
    if (target.sellerId === uid) throw new HttpsError('failed-precondition', 'cannot trade with self');

    // Check daily limit
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dailyQ = db.collection('trade_offers')
      .where('senderUserId', '==', uid)
      .where('createdAt', '>=', today);
    const dailySnap = await tx.get(dailyQ);
    if (dailySnap.size >= 10) throw new HttpsError('resource-exhausted', 'daily limit reached');

    // Check existing
    const existingQ = db.collection('trade_offers')
      .where('senderUserId', '==', uid)
      .where('targetListingId', '==', targetListingId)
      .where('status', 'in', ['pending', 'viewed']);
    const existingSnap = await tx.get(existingQ);
    if (!existingSnap.empty) throw new HttpsError('already-exists', 'active offer exists');

    const offerRef = db.collection('trade_offers').doc();
    newOfferId = offerRef.id;

    tx.set(offerRef, {
      targetListingId,
      senderUserId: uid,
      receiverUserId: target.sellerId,
      offeredCashAmount: Number(cashOffer) || 0,
      requestedCashAmount: 0,
      message: String(message || '').trim(),
      status: 'pending',
      lastActionBy: uid,
      parentOfferId: counterOfferId || null,
      expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + 3 * 24 * 60 * 60 * 1000),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    if (counterOfferId) {
      const counterRef = db.collection('trade_offers').doc(counterOfferId);
      tx.update(counterRef, {
        status: 'countered',
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      
      tx.set(db.collection('trade_status_history').doc(), {
        tradeOfferId: counterOfferId,
        oldStatus: 'pending',
        newStatus: 'countered',
        changedBy: uid,
        note: 'Karşı teklif oluşturuldu',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    // Add target item
    tx.set(db.collection('trade_offer_items').doc(), {
      tradeOfferId: newOfferId,
      listingId: targetListingId,
      ownerUserId: target.sellerId,
      declaredValue: target.price || 0,
      isTarget: true
    });

    // Add offered items
    if (Array.isArray(offeredListingIds)) {
      for (const listingId of offeredListingIds) {
        const itemRef = db.collection('products').doc(listingId);
        const itemSnap = await tx.get(itemRef);
        if (itemSnap.exists) {
          const item = itemSnap.data() as any;
          if (item.sellerId === uid) {
            tx.set(db.collection('trade_offer_items').doc(), {
              tradeOfferId: newOfferId,
              listingId,
              ownerUserId: uid,
              declaredValue: item.price || 0,
            });
          }
        }
      }
    }

    tx.set(db.collection('trade_status_history').doc(), {
      tradeOfferId: newOfferId,
      oldStatus: null,
      newStatus: 'pending',
      changedBy: uid,
      note: counterOfferId ? 'Karşı teklif olarak oluşturuldu' : 'Teklif oluşturuldu',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    tx.set(db.collection('notifications').doc(), {
      userId: target.sellerId,
      type: 'info',
      title: counterOfferId ? 'Yeni Karşı Teklif' : 'Yeni Takas Teklifi',
      message: counterOfferId 
        ? `${target.title} ilanınız için bir karşı teklif aldınız.`
        : `${target.title} ilanınız için yeni bir takas teklifi aldınız.`,
      isRead: false,
      link: `/trade/offers/${newOfferId}`,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  });

  return { offerId: newOfferId };
});

export const notifyTradeMessage = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required.');
  const { offerId, message } = request.data;
  if (!offerId) throw new HttpsError('invalid-argument', 'offerId required');

  const offerRef = db.collection('trade_offers').doc(offerId);
  const offerSnap = await offerRef.get();
  if (!offerSnap.exists) throw new HttpsError('not-found', 'offer not found');
  const offer = offerSnap.data() as any;

  if (offer.senderUserId !== uid && offer.receiverUserId !== uid) {
    throw new HttpsError('permission-denied', 'not participant');
  }

  const otherUserId = uid === offer.senderUserId ? offer.receiverUserId : offer.senderUserId;
  const userRef = db.collection('users').doc(uid);
  const userSnap = await userRef.get();
  const userData = userSnap.data() as any;

  await db.collection('notifications').add({
    userId: otherUserId,
    type: 'info',
    title: 'Yeni Takas Mesajı',
    message: `${userData?.username || 'Kullanıcı'} size bir mesaj gönderdi.`,
    isRead: false,
    link: `/trade/offers/${offerId}`,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  return { ok: true };
});

export const notifyTradeDispute = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required.');
  const { offerId } = request.data;
  if (!offerId) throw new HttpsError('invalid-argument', 'offerId required');

  const offerRef = db.collection('trade_offers').doc(offerId);
  const offerSnap = await offerRef.get();
  if (!offerSnap.exists) throw new HttpsError('not-found', 'offer not found');
  const offer = offerSnap.data() as any;

  if (offer.senderUserId !== uid && offer.receiverUserId !== uid) {
    throw new HttpsError('permission-denied', 'not participant');
  }

  const otherUserId = uid === offer.senderUserId ? offer.receiverUserId : offer.senderUserId;

  await db.collection('notifications').add({
    userId: otherUserId,
    type: 'warning',
    title: 'Takas Uyuşmazlığı Bildirildi',
    message: 'Bu takas için bir uyuşmazlık kaydı oluşturuldu. Destek ekibi inceleyecektir.',
    isRead: false,
    link: `/trade/offers/${offerId}`,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  return { ok: true };
});

// -----------------------------------------------------------------------------
// SMS OTP (mock): provider erişimi gelene kadar emulator-friendly
// -----------------------------------------------------------------------------
export const smsSend = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required.');
  const { phone } = (request.data || {}) as { phone?: string };
  const clean = String(phone || '').replace(/[^\d+]/g, '').trim();
  if (clean.length < 8) throw new HttpsError('invalid-argument', 'phone required');

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const otpRef = db.collection('smsOtps').doc();
  await otpRef.set({
    userId: uid,
    phone: clean,
    code,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + 5 * 60 * 1000)
  });

  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true';
  return { ok: true, devCode: isEmulator ? code : null };
});

export const smsVerify = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required.');
  const { phone, code } = (request.data || {}) as { phone?: string; code?: string };
  const clean = String(phone || '').replace(/[^\d+]/g, '').trim();
  const c = String(code || '').trim();
  if (clean.length < 8) throw new HttpsError('invalid-argument', 'phone required');
  if (!/^\d{6}$/.test(c)) throw new HttpsError('invalid-argument', 'code must be 6 digits');

  // Find latest OTP for this user+phone
  const snap = await db
    .collection('smsOtps')
    .where('userId', '==', uid)
    .where('phone', '==', clean)
    .orderBy('expiresAt', 'desc')
    .limit(1)
    .get();

  if (snap.empty) throw new HttpsError('failed-precondition', 'otp not found');
  const doc0 = snap.docs[0];
  const otp = doc0.data() as any;
  if (otp.code !== c) throw new HttpsError('permission-denied', 'invalid code');
  if (otp.expiresAt?.toMillis && otp.expiresAt.toMillis() < Date.now()) throw new HttpsError('deadline-exceeded', 'code expired');

  await db.runTransaction(async (tx: FirebaseFirestore.Transaction) => {
    tx.delete(doc0.ref);
    tx.set(
      db.collection('users').doc(uid),
      { smsVerified: true, phone: clean, withdrawEnabled: true },
      { merge: true }
    );
  });

  return { ok: true };
});

