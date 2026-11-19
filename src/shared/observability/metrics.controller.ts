import { Controller, Get, Header } from "@nestjs/common";
import { MetricsService } from "./metrics.service";

@Controller("metrics")
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  @Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
  getPrometheusMetrics(): string {
    return this.metrics.toPrometheusText();
  }

  @Get("json")
  getJsonMetrics() {
    return this.metrics.snapshot();
  }
}
