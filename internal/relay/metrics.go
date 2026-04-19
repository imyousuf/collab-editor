package relay

import (
	"github.com/prometheus/client_golang/prometheus"
)

// Metrics holds all Prometheus metrics for the relay.
type Metrics struct {
	Registry            *prometheus.Registry
	RoomsActive         prometheus.Gauge
	PeersConnected      prometheus.Gauge
	UpdatesRelayedTotal *prometheus.CounterVec
	UpdatesBuffered     *prometheus.GaugeVec
	FlushDurationMs     prometheus.Histogram
	FlushErrorsTotal    *prometheus.CounterVec
	ProviderLatencyMs   *prometheus.HistogramVec
	ProviderCircuitOpen prometheus.Gauge
}

func NewMetrics() *Metrics {
	return NewMetricsWithRegistry(prometheus.NewRegistry())
}

func NewMetricsWithRegistry(reg *prometheus.Registry) *Metrics {
	m := &Metrics{Registry: reg}

	m.RoomsActive = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "collab_relay_rooms_active",
		Help: "Number of active document rooms",
	})
	m.PeersConnected = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "collab_relay_peers_connected",
		Help: "Number of connected peers",
	})
	m.UpdatesRelayedTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "collab_relay_updates_relayed_total",
		Help: "Total number of updates relayed",
	}, []string{"document_id"})
	m.UpdatesBuffered = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "collab_relay_updates_buffered",
		Help: "Number of updates currently buffered",
	}, []string{"document_id"})
	m.FlushDurationMs = prometheus.NewHistogram(prometheus.HistogramOpts{
		Name:    "collab_relay_flush_duration_ms",
		Help:    "Duration of flush operations in milliseconds",
		Buckets: prometheus.ExponentialBuckets(1, 2, 12),
	})
	m.FlushErrorsTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "collab_relay_flush_errors_total",
		Help: "Total number of flush errors",
	}, []string{"status_code"})
	m.ProviderLatencyMs = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "collab_relay_provider_latency_ms",
		Help:    "Provider HTTP request latency in milliseconds",
		Buckets: prometheus.ExponentialBuckets(1, 2, 14),
	}, []string{"endpoint"})
	m.ProviderCircuitOpen = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "collab_relay_provider_circuit_open",
		Help: "Whether the provider circuit breaker is open (1=open, 0=closed)",
	})

	reg.MustRegister(
		m.RoomsActive, m.PeersConnected, m.UpdatesRelayedTotal,
		m.UpdatesBuffered, m.FlushDurationMs, m.FlushErrorsTotal,
		m.ProviderLatencyMs, m.ProviderCircuitOpen,
	)

	return m
}
