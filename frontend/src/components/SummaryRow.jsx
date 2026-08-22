export default function SummaryRow({ balance, totalHashrate, pendingTotal }) {
  return (
    <div className="summary-row">
      <div className="summary-item">
        <span className="summary-label">Wallet Balance</span>
        <span className="summary-value">{Number(balance).toFixed(4)} USDC</span>
      </div>
      <div className="summary-item">
        <span className="summary-label">Your Total Hashrate</span>
        <span className="summary-value">{Number(totalHashrate).toFixed(4)} GH/s</span>
      </div>
      <div className="summary-item">
        <span className="summary-label">Your Pending Payouts</span>
        <span className="summary-value accent">{Number(pendingTotal).toFixed(8)}</span>
      </div>
    </div>
  );
}
