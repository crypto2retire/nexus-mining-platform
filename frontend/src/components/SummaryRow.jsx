export default function SummaryRow({ balance, totalHashrate, pendingTotal }) {
  return (
    <div className="summary-row">
      <div className="summary-item">
        <span className="summary-label">Wallet Balance</span>
        <span className="summary-value">{balance.toFixed(4)} USDC</span>
      </div>
      <div className="summary-item">
        <span className="summary-label">Total Hashrate</span>
        <span className="summary-value">{totalHashrate.toFixed(4)} GH/s</span>
      </div>
      <div className="summary-item">
        <span className="summary-label">Total Pending Yield</span>
        <span className="summary-value accent">{pendingTotal.toFixed(8)}</span>
      </div>
    </div>
  );
}
