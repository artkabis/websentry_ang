import { Module } from '@nestjs/common';
import { AnalysisModule } from '../analysis/analysis.module.js';
import { ScansModule } from '../scans/scans.module.js';
import { SupervisionController } from './supervision.controller.js';
import { SupervisionService } from './supervision.service.js';

@Module({
  imports: [AnalysisModule, ScansModule],
  controllers: [SupervisionController],
  providers: [SupervisionService],
})
export class SupervisionModule {}
