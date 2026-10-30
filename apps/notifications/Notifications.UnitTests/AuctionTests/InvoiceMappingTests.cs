using Auction.V1;
using Notifications.Auction;
using Notifications.TestKit;
using Shouldly;
using Xunit;

namespace Notifications.UnitTests.AuctionTests;

/// <summary>
/// Разбор фактов счёта: из них живут задания напоминания о неоплаченном счёте
/// (PER-330), поэтому снимок должен называть адресата, сумму и срок оплаты.
/// </summary>
public class InvoiceMappingTests
{
    [Fact]
    public void When_PaymentHasNotStarted_Expect_NoDeadline()
    {
        var message = EventFactory.Invoice(EventFactory.InvoiceOfSale(), EventFactory.NewId());
        message.State.PaymentDueAt = "";
        Decode(AuctionFeed.InvoiceIssuedSubject, message).Snapshot.PaymentDueAt.ShouldBeNull();
    }

    [Fact]
    public void When_PaymentDeadlineStarts_Expect_ReminderAnchorAtTheChange()
    {
        var message = EventFactory.Invoice(EventFactory.InvoiceOfSale(), EventFactory.NewId(), version: 2);
        message.InvoicePaymentDueChanged = new InvoicePaymentDueChanged();
        var result = Decode(AuctionFeed.InvoicePaymentDueChangedSubject, message);
        result.Snapshot.PaymentDueAt.ShouldNotBeNull();
        result.Snapshot.Issued.ShouldBeTrue();
    }

    [Fact]
    public void When_InvoiceRaised_Expect_SnapshotWithWinnerAmountAndDeadline()
    {
        var invoiceId = EventFactory.InvoiceOfSale();
        var lotId = EventFactory.NewId();
        var winner = EventFactory.NewId();
        var message = EventFactory.Invoice(invoiceId, lotId, winner);

        var invoice = Decode(AuctionFeed.InvoiceIssuedSubject, message);

        invoice.EventId.ShouldBe(Guid.Parse(message.EventId));
        invoice.Snapshot.InvoiceId.ShouldBe(Guid.Parse(invoiceId));
        invoice.Snapshot.Status.ShouldBe(InvoiceStatus.AwaitingPayment);
        invoice.Snapshot.WinnerId.ShouldBe(Guid.Parse(winner));
        invoice.Snapshot.LotId.ShouldBe(Guid.Parse(lotId));
        invoice.Snapshot.AmountMinorUnits.ShouldBe(45600);
        invoice.Snapshot.AmountCurrency.ShouldBe("RUB");
        invoice.Snapshot.PaymentDueAt.ShouldBe(DateTimeOffset.Parse(message.State.PaymentDueAt,
            System.Globalization.CultureInfo.InvariantCulture));
        // Момент выставления знает только факт выставления: по нему считается
        // первое напоминание.
        invoice.Snapshot.Issued.ShouldBeTrue();
        invoice.Snapshot.OccurredAt.ShouldBe(DateTimeOffset.Parse(message.OccurredAt,
            System.Globalization.CultureInfo.InvariantCulture));
    }

    [Fact]
    public void When_InvoicePaid_Expect_PaidStatusWithoutIssueMoment()
    {
        var invoiceId = EventFactory.InvoiceOfSale();
        var message = EventFactory.Invoice(invoiceId, EventFactory.NewId(), version: 2, issued: false);

        var invoice = Decode(AuctionFeed.InvoicePaidSubject, message);

        invoice.Snapshot.Status.ShouldBe(InvoiceStatus.Paid);
        invoice.Snapshot.Issued.ShouldBeFalse();
    }

    [Fact]
    public void When_SubjectAndOccasionDisagree_Expect_Poison()
    {
        var message = EventFactory.Invoice(EventFactory.InvoiceOfSale(), EventFactory.NewId());

        AuctionMapping.Decode(AuctionFeed.InvoicePaidSubject, EventFactory.Bytes(message))
            .ShouldBeOfType<AuctionDecoded.Poison>();
    }

    [Fact]
    public void When_StateDoesNotMatchTheOccasion_Expect_Poison()
    {
        // Выставленный счёт не может нести состояние «оплачено»: сообщение не
        // о том факте, который объявил subject.
        var message = EventFactory.Invoice(EventFactory.InvoiceOfSale(), EventFactory.NewId());
        message.State.Paid = new InvoiceState.Types.Paid();
        message.State.AwaitingPayment = null;

        AuctionMapping.Decode(AuctionFeed.InvoiceIssuedSubject, EventFactory.Bytes(message))
            .ShouldBeOfType<AuctionDecoded.Poison>();
    }

    [Fact]
    public void When_InvoiceIdIsNotUuidV5_Expect_Poison()
    {
        // Счёт выводится из ставки продажи и несёт UUIDv5; UUIDv7 — это
        // идентификатор лота.
        var message = EventFactory.Invoice(EventFactory.NewId(), EventFactory.NewId());

        AuctionMapping.Decode(AuctionFeed.InvoiceIssuedSubject, EventFactory.Bytes(message))
            .ShouldBeOfType<AuctionDecoded.Poison>();
    }

    [Fact]
    public void When_PayloadIsNotAnInvoiceEvent_Expect_Poison()
    {
        AuctionMapping.Decode(AuctionFeed.InvoiceIssuedSubject, new byte[] { 0xff })
            .ShouldBeOfType<AuctionDecoded.Poison>();
    }

    [Fact]
    public void When_HandedOverInvoiceArrives_Expect_Ignored()
    {
        // Выдача счёта этому модулю не нужна: напоминаний к тому времени не
        // остаётся, и заявленным потребителем она не значится.
        var message = EventFactory.Invoice(EventFactory.InvoiceOfSale(), EventFactory.NewId());

        AuctionMapping.Decode("events.auction.invoice_handed_over", EventFactory.Bytes(message))
            .ShouldBeOfType<AuctionDecoded.Ignored>();
    }

    private static AuctionInvoice Decode(string subject, InvoiceEvent message) =>
        AuctionMapping.Decode(subject, EventFactory.Bytes(message)).ShouldBeOfType<AuctionDecoded.Invoice>().Value;
}
