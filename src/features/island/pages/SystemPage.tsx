import { percent, temperature, type SystemSample } from "../useSystemSample";

const utilization = [
  { key: "cpu", label: "CPU" },
  { key: "gpu", label: "GPU" },
  { key: "ram", label: "RAM" },
  { key: "disk", label: "Disk" },
] as const;

function rate(bytes: number | null | undefined) {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B/s`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB/s`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB/s`;
}

export default function SystemPage({ sample }: { sample: SystemSample | null }) {
  const thermal = temperature(sample);

  return (
    <div className="island-system-groups">
      <section className="island-system-group" aria-label="Hardware">
        <div className="island-system-heading">
          <h3>Hardware</h3>
          <span className="island-thermal-badge" title={thermal.label} aria-label={`${thermal.label} ${thermal.value}`}>
            {sample?.gpuTemperature != null ? "GPU" : "TEMP"} {thermal.value}
          </span>
        </div>
        <dl className="island-metrics island-hardware">
          {utilization.map(({ key, label }) => {
            const value = sample?.[key];
            return (
              <div className="island-metric" key={key}>
                <dt title={key === "disk" ? "Disk activity" : undefined}>{label}</dt>
                <dd>{percent(value)}</dd>
                <div className="island-meter" aria-hidden="true"><span style={{ width: `${value ?? 0}%` }} /></div>
              </div>
            );
          })}
        </dl>
      </section>
      <section className="island-system-group" aria-label="Network">
        <div className="island-system-heading"><h3>Network</h3></div>
        <dl className="island-metrics island-network">
          <div className="island-metric"><dt>↑ Upload</dt><dd>{rate(sample?.upload)}</dd></div>
          <div className="island-metric"><dt>↓ Download</dt><dd>{rate(sample?.download)}</dd></div>
        </dl>
      </section>
    </div>
  );
}
