function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

export default function PayoutHistory({ payouts = [] }) {
  return (
    <section className="payout-history" aria-labelledby="payout-history-title">
      <h2 id="payout-history-title">Past payouts</h2>

      {payouts.length === 0 ? (
        <p className="payout-history-empty">
          No payouts yet — your mining rewards and game rewards will appear here.
        </p>
      ) : (
        <div className="payout-history-table-wrap">
          <table className="payout-history-table">
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Room / game</th>
                <th scope="col">Amount</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {payouts.map((payout, index) => (
                <tr key={`${payout.kind}-${payout.date}-${payout.symbol}-${index}`}>
                  <td className="payout-history-date">{formatDate(payout.date)}</td>
                  <td>{payout.kind === 'game' ? 'Daily Game' : payout.pool}</td>
                  <td className="payout-history-amount">{payout.amount} {payout.symbol}</td>
                  <td>{payout.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
