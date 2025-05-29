/**
 * Metrics collection for monitoring proxy performance
 */

export interface MetricData {
  timestamp: number;
  value: number;
  labels?: Record<string, string>;
}

export interface HistogramBucket {
  le: number; // less than or equal
  count: number;
}

export class MetricsCollector {
  private counters: Map<string, number> = new Map();
  private gauges: Map<string, number> = new Map();
  private histograms: Map<string, number[]> = new Map();
  private timers: Map<string, number> = new Map();

  // Histogram buckets for response times (in ms)
  private readonly histogramBuckets = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

  /**
   * Increment a counter metric
   */
  incrementCounter(name: string, value: number = 1, labels?: Record<string, string>): void {
    const key = this.getMetricKey(name, labels);
    const current = this.counters.get(key) || 0;
    this.counters.set(key, current + value);
  }

  /**
   * Set a gauge metric
   */
  setGauge(name: string, value: number, labels?: Record<string, string>): void {
    const key = this.getMetricKey(name, labels);
    this.gauges.set(key, value);
  }

  /**
   * Record a value in a histogram
   */
  recordHistogram(name: string, value: number, labels?: Record<string, string>): void {
    const key = this.getMetricKey(name, labels);
    if (!this.histograms.has(key)) {
      this.histograms.set(key, []);
    }
    this.histograms.get(key)!.push(value);
  }

  /**
   * Start a timer
   */
  startTimer(name: string, labels?: Record<string, string>): () => void {
    const key = this.getMetricKey(name, labels);
    const startTime = Date.now();
    
    return () => {
      const duration = Date.now() - startTime;
      this.recordHistogram(name, duration, labels);
    };
  }

  /**
   * Get all metrics in Prometheus format
   */
  getMetricsPrometheus(): string {
    const lines: string[] = [];

    // Counters
    this.counters.forEach((value, key) => {
      lines.push(`# TYPE ${this.getMetricName(key)} counter`);
      lines.push(`${key} ${value}`);
    });

    // Gauges
    this.gauges.forEach((value, key) => {
      lines.push(`# TYPE ${this.getMetricName(key)} gauge`);
      lines.push(`${key} ${value}`);
    });

    // Histograms
    this.histograms.forEach((values, key) => {
      const metricName = this.getMetricName(key);
      lines.push(`# TYPE ${metricName} histogram`);
      
      const buckets = this.calculateHistogramBuckets(values);
      buckets.forEach(bucket => {
        lines.push(`${metricName}_bucket{le="${bucket.le}"} ${bucket.count}`);
      });
      
      lines.push(`${metricName}_bucket{le="+Inf"} ${values.length}`);
      lines.push(`${metricName}_sum ${values.reduce((a, b) => a + b, 0)}`);
      lines.push(`${metricName}_count ${values.length}`);
    });

    return lines.join('\n');
  }

  /**
   * Get metrics summary as JSON
   */
  getMetricsSummary(): Record<string, any> {
    const summary: Record<string, any> = {
      counters: {},
      gauges: {},
      histograms: {},
    };

    // Convert counters
    this.counters.forEach((value, key) => {
      summary.counters[key] = value;
    });

    // Convert gauges
    this.gauges.forEach((value, key) => {
      summary.gauges[key] = value;
    });

    // Convert histograms to percentiles
    this.histograms.forEach((values, key) => {
      if (values.length > 0) {
        const sorted = values.sort((a, b) => a - b);
        summary.histograms[key] = {
          count: values.length,
          sum: values.reduce((a, b) => a + b, 0),
          avg: values.reduce((a, b) => a + b, 0) / values.length,
          min: sorted[0],
          max: sorted[sorted.length - 1],
          p50: this.percentile(sorted, 0.5),
          p90: this.percentile(sorted, 0.9),
          p95: this.percentile(sorted, 0.95),
          p99: this.percentile(sorted, 0.99),
        };
      }
    });

    return summary;
  }

  /**
   * Reset all metrics
   */
  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
    this.timers.clear();
  }

  private getMetricKey(name: string, labels?: Record<string, string>): string {
    if (!labels || Object.keys(labels).length === 0) {
      return name;
    }

    const labelPairs = Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}="${v}"`)
      .join(',');

    return `${name}{${labelPairs}}`;
  }

  private getMetricName(key: string): string {
    const match = key.match(/^([^{]+)/);
    return match ? match[1] : key;
  }

  private calculateHistogramBuckets(values: number[]): HistogramBucket[] {
    const buckets: HistogramBucket[] = [];
    
    for (const bucketLimit of this.histogramBuckets) {
      const count = values.filter(v => v <= bucketLimit).length;
      buckets.push({ le: bucketLimit, count });
    }

    return buckets;
  }

  private percentile(sortedValues: number[], p: number): number {
    const index = Math.ceil(sortedValues.length * p) - 1;
    return sortedValues[Math.max(0, index)];
  }
}

// Global metrics instance
export const metrics = new MetricsCollector();

// Common metric names
export const MetricNames = {
  // Request metrics
  REQUEST_TOTAL: 'porteight_proxy_requests_total',
  REQUEST_DURATION: 'porteight_proxy_request_duration_ms',
  REQUEST_ERROR: 'porteight_proxy_request_errors_total',
  
  // Cache metrics
  CACHE_HIT: 'porteight_proxy_cache_hits_total',
  CACHE_MISS: 'porteight_proxy_cache_misses_total',
  CACHE_ERROR: 'porteight_proxy_cache_errors_total',
  
  // Token metrics
  TOKEN_GENERATED: 'porteight_proxy_tokens_generated_total',
  TOKEN_GENERATION_DURATION: 'porteight_proxy_token_generation_duration_ms',
  TOKEN_GENERATION_ERROR: 'porteight_proxy_token_generation_errors_total',
  
  // Database metrics
  DB_QUERY_TOTAL: 'porteight_proxy_db_queries_total',
  DB_QUERY_DURATION: 'porteight_proxy_db_query_duration_ms',
  DB_QUERY_ERROR: 'porteight_proxy_db_query_errors_total',
  
  // Connection pool metrics
  POOL_CONNECTIONS_ACTIVE: 'porteight_proxy_pool_connections_active',
  POOL_CONNECTIONS_IDLE: 'porteight_proxy_pool_connections_idle',
  POOL_CONNECTIONS_TOTAL: 'porteight_proxy_pool_connections_total',
  
  // Tinybird metrics
  TINYBIRD_REQUEST_TOTAL: 'porteight_proxy_tinybird_requests_total',
  TINYBIRD_REQUEST_DURATION: 'porteight_proxy_tinybird_request_duration_ms',
  TINYBIRD_REQUEST_ERROR: 'porteight_proxy_tinybird_request_errors_total',
}; 