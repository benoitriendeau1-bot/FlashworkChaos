function fail(error) {
  return { ok: false, error };
}

function asString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Read production ids from the work-order detail object returned by the API.
 * Fails when a required field is missing instead of searching a serialized blob.
 */
export function resolveWorkOrderIds(detail) {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) {
    return fail('Work order detail is not an object');
  }
  const workOrderId = asString(detail.workOrder?.workOrderId);
  if (!workOrderId) return fail('Work order detail is missing workOrder.workOrderId');
  if (!Array.isArray(detail.operations)) return fail('Work order detail is missing an operations array');

  const operations = [];
  for (const operation of detail.operations) {
    const proOpeId = asString(operation?.proOpeId);
    const operationNo = operation?.operationNo == null ? null : String(operation.operationNo);
    if (!proOpeId || !operationNo) return fail('An operation is missing proOpeId or operationNo');
    if (!Array.isArray(operation.steps)) return fail('Operation ' + operationNo + ' is missing a steps array');
    const steps = [];
    for (const step of operation.steps) {
      const proOpeStepId = asString(step?.proOpeStepId);
      const stepNo = step?.stepOrder ?? step?.stepNo;
      if (!proOpeStepId || stepNo == null) return fail('Operation ' + operationNo + ' has a step without proOpeStepId or step number');
      const dataPoints = [];
      for (const point of step.dataPoints ?? []) {
        const proStepDataId = asString(point?.proStepDataId);
        if (!proStepDataId) return fail('A data point is missing proStepDataId');
        const sample = Array.isArray(point.samples)
          ? point.samples.find((row) => Number(row.sampleIndex) === 1) ?? point.samples[0]
          : null;
        const column = (key) => {
          if (sample && Object.prototype.hasOwnProperty.call(sample, key)) return sample[key] ?? null;
          if (Object.prototype.hasOwnProperty.call(point, key)) return point[key] ?? null;
          return null;
        };
        const rule = point.validationRule && typeof point.validationRule === 'object' ? point.validationRule : {};
        const rawChoices = Array.isArray(point.enumChoices) ? point.enumChoices : rule.enumChoices;
        const enumChoices = Array.isArray(rawChoices)
          ? rawChoices.map((item) => String(item).trim()).filter(Boolean)
          : [];
        dataPoints.push({
          proStepDataId,
          referenceCode: point.referenceCode ?? null,
          dataType: point.dataType ?? null,
          isMandatory: point.isMandatory === true,
          enumChoices,
          defaultValue: rule.defaultValue ?? point.defaultValue ?? null,
          minValue: rule.minValue ?? point.minValue ?? null,
          maxValue: rule.maxValue ?? point.maxValue ?? null,
          captureStatus: column('captureStatus'),
          capturedValueNumber: column('capturedValueNumber'),
          capturedValueText: column('capturedValueText'),
          capturedValueBool: column('capturedValueBool'),
        });
      }
      const parts = [];
      for (const part of step.parts ?? []) {
        const proStepPartId = asString(part?.proStepPartId);
        const partId = asString(part?.partId);
        if (!proStepPartId) return fail('A part row is missing proStepPartId');
        const units = [];
        for (const unit of part.units ?? []) {
          const proStepPartUnitId = asString(unit?.proStepPartUnitId);
          if (!proStepPartUnitId) return fail('A part unit is missing proStepPartUnitId');
          units.push({
            proStepPartUnitId,
            unitIndex: unit.unitIndex ?? null,
            serialNo: unit.serialNo ?? null,
            lotNo: unit.lotNo ?? null,
            heatNo: unit.heatNo ?? null,
          });
        }
        const lotLines = [];
        for (const line of part.lotLines ?? []) {
          const proStepPartLotLineId = asString(line?.proStepPartLotLineId);
          if (!proStepPartLotLineId) return fail('A lot line is missing proStepPartLotLineId');
          lotLines.push({
            proStepPartLotLineId,
            lineIndex: line.lineIndex ?? null,
            quantity: line.quantity ?? null,
            lotNo: line.lotNo ?? null,
            heatNo: line.heatNo ?? null,
          });
        }
        parts.push({
          proStepPartId,
          partId,
          partNumber: part.partNumber ?? null,
          traceabilityMode: part.traceabilityMode ?? null,
          quantityRequired: part.quantityRequired ?? null,
          quantityActual: part.quantityActual ?? null,
          serialNo: part.serialNo ?? null,
          lotNo: part.lotNo ?? null,
          heatNo: part.heatNo ?? null,
          verificationStatus: part.verificationStatus ?? null,
          units,
          lotLines,
        });
      }
      const tools = [];
      for (const tool of step.tools ?? []) {
        const proStepToolId = asString(tool?.proStepToolId);
        if (!proStepToolId) return fail('A tool row is missing proStepToolId');
        tools.push({
          proStepToolId,
          toolId: asString(tool?.toolId) || null,
          toolNumber: tool.toolNumber ?? null,
          capturePolicy: tool.capturePolicy ?? null,
          useQty: tool.useQty ?? null,
          toolInstanceId: tool.toolInstanceId ?? null,
          assetTag: tool.assetTag ?? null,
          serialNo: tool.serialNo ?? null,
          toolSerialNo: tool.toolSerialNo ?? null,
          calibrationStatus: tool.calibrationStatus ?? null,
        });
      }
      const signoffs = [];
      for (const signoff of step.signoffs ?? []) {
        const proStepSignoffId = asString(signoff?.proStepSignoffId);
        if (!proStepSignoffId) return fail('A sign-off row is missing proStepSignoffId');
        signoffs.push({
          proStepSignoffId,
          signOffRequirementId: signoff.signOffRequirementId ?? null,
          scope: signoff.scope ?? null,
          requiredPrivilege: signoff.requiredPrivilege ?? null,
          requiresUniqueSignerWithinStep: signoff.requiresUniqueSignerWithinStep ?? null,
          category: signoff.category ?? null,
          seqNo: signoff.seqNo ?? null,
          level: signoff.level ?? null,
          signedBy: signoff.signedBy ?? null,
          signedAt: signoff.signedAt ?? null,
          outcome: signoff.outcome ?? null,
          comment: signoff.comment ?? null,
          skipReasonId: signoff.skipReasonId ?? null,
          skipReasonCodeSnapshot: signoff.skipReasonCodeSnapshot ?? null,
        });
      }
      steps.push({ proOpeStepId, stepNo: String(stepNo), dataPoints, parts, tools, signoffs });
    }
    operations.push({ proOpeId, operationNo, steps });
  }
  return { ok: true, workOrderId, operations };
}

export function findStep(resolved, operationNo, stepNo) {
  const operation = resolved.operations.find((item) => item.operationNo === String(operationNo));
  if (!operation) return null;
  return operation.steps.find((step) => step.stepNo === String(stepNo)) ?? null;
}

export function partFingerprint(resolved) {
  if (!resolved?.ok) return null;
  return resolved.operations.flatMap((operation) => operation.steps.flatMap((step) => step.parts.map((part) => ({
    operationNo: operation.operationNo,
    proOpeId: operation.proOpeId,
    stepNo: step.stepNo,
    proOpeStepId: step.proOpeStepId,
    proStepPartId: part.proStepPartId,
    partId: part.partId,
    partNumber: part.partNumber,
    traceabilityMode: part.traceabilityMode,
    quantityRequired: part.quantityRequired,
    quantityActual: part.quantityActual,
    serialNo: part.serialNo,
    lotNo: part.lotNo,
    heatNo: part.heatNo,
    verificationStatus: part.verificationStatus,
    units: part.units,
    lotLines: part.lotLines,
  }))));
}

export function toolEventSignature(events) {
  return (Array.isArray(events) ? events : []).map((event) => ({
    eventType: event?.eventType ?? null,
    fieldName: event?.fieldName ?? null,
    oldValue: event?.oldValue ?? null,
    newValue: event?.newValue ?? null,
  }));
}

export function signoffEventSignature(events) {
  return (Array.isArray(events) ? events : []).map((event) => ({
    eventType: event?.eventType ?? null,
    performedBy: event?.performedBy ?? null,
    resultingStatus: event?.resultingStatus ?? null,
    comment: event?.comment ?? null,
    skipReasonId: event?.skipReasonId ?? null,
    reopenReasonId: event?.reopenReasonId ?? null,
  }));
}

export function partEventSignature(events) {
  return (Array.isArray(events) ? events : []).map((event) => ({
    eventType: event?.eventType ?? null,
    fieldName: event?.fieldName ?? null,
    lotLineIndex: event?.lotLineIndex ?? null,
    proStepPartUnitId: event?.proStepPartUnitId ?? null,
    oldValue: event?.oldValue ?? null,
    newValue: event?.newValue ?? null,
  }));
}

/**
 * Work-order detail plus the order/unit context, read from the objects themselves.
 * Operation and step status come from the same rows resolveWorkOrderIds already walked.
 */
export function adaptLifecycleWorkOrder(detail, context = {}) {
  const resolved = resolveWorkOrderIds(detail);
  if (!resolved.ok) return resolved;
  const workOrder = detail.workOrder;
  const operations = resolved.operations.map((operation, index) => {
    const source = detail.operations[index];
    return {
      ...operation,
      status: source?.status ?? null,
      mustCompleteBeforeLater: source?.mustCompleteBeforeLater === true,
      operationName: source?.operationName ?? null,
      startedAt: source?.startedAt ?? null,
      completedAt: source?.completedAt ?? null,
      steps: operation.steps.map((step, stepIndex) => {
        const sourceStep = source?.steps?.[stepIndex] ?? {};
        return {
          ...step,
          status: sourceStep.status ?? null,
          stepTitle: sourceStep.stepTitle ?? null,
          startedAt: sourceStep.startedAt ?? null,
          completedAt: sourceStep.completedAt ?? null,
          unitIdentity: sourceStep.unitIdentity ?? null,
        };
      }),
    };
  });
  return {
    ok: true,
    workOrderId: resolved.workOrderId,
    workOrderNo: asString(workOrder.workOrderNo),
    runNo: workOrder.runNo ?? null,
    unitIndex: workOrder.unitIndex ?? context.unitIndex ?? null,
    status: asString(workOrder.status),
    unitStatus: context.unitStatus ?? null,
    poStatus: context.poStatus ?? null,
    poQuantityCompleted: context.poQuantityCompleted ?? null,
    operations,
  };
}

export function captureFingerprint(resolved) {
  if (!resolved?.ok) return null;
  return resolved.operations.flatMap((operation) => operation.steps.flatMap((step) => step.dataPoints.map((point) => ({
    operationNo: operation.operationNo,
    stepNo: step.stepNo,
    referenceCode: point.referenceCode,
    captureStatus: point.captureStatus,
    capturedValueNumber: point.capturedValueNumber,
    capturedValueText: point.capturedValueText,
    capturedValueBool: point.capturedValueBool,
  }))));
}
