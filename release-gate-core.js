function validateSheetLayout(layout) {
  const issues = [];
  if (!layout || !Array.isArray(layout.sheets)) {
    issues.push("Не сформирована раскладка листов.");
    return issues;
  }

  const sheetLength = Number(layout.sheetLength);
  const sheetWidth = Number(layout.sheetWidth);
  const margin = Number(layout.margin);
  const kerf = Number(layout.kerf);

  if (!(sheetLength > 0) || !(sheetWidth > 0) || !(margin >= 0) || !(kerf >= 0)) {
    issues.push("Некорректные параметры листа/припуска/пропила.");
    return issues;
  }

  layout.sheets.forEach(sheet => {
    const placements = Array.isArray(sheet.placements) ? sheet.placements : [];
    placements.forEach((placement, index) => {
      if (sheet.thickness != null && Number(placement.thickness || sheet.thickness) !== Number(sheet.thickness)) {
        issues.push(
          "Лист " + sheet.sheetNumber + ": смешаны детали разной толщины."
        );
      }

      for (let j = 0; j < index; j++) {
        const other = placements[j];
        const separated =
          placement.x >= other.x + other.length + kerf ||
          other.x >= placement.x + placement.length + kerf ||
          placement.y >= other.y + other.width + kerf ||
          other.y >= placement.y + placement.width + kerf;
        if (!separated) {
          issues.push(
            "Лист " + sheet.sheetNumber + ": пересечение деталей " +
            (other.partNumber || "без номера") + " и " +
            (placement.partNumber || "без номера") + "."
          );
        }
      }

      if (placement.overflow) {
        issues.push(
          "Деталь " + (placement.partNumber || "без номера") +
          " не помещается на лист " + sheet.sheetNumber + "."
        );
      }

      const x = Number(placement.x);
      const y = Number(placement.y);
      const length = Number(placement.length);
      const width = Number(placement.width);

      if (!(length > 0) || !(width > 0) ||
          x < margin || y < margin ||
          x + length > sheetLength - margin ||
          y + width > sheetWidth - margin) {
        issues.push(
          "Деталь " + (placement.partNumber || "без номера") +
          " выходит за рабочую область листа " + sheet.sheetNumber + "."
        );
      }
    });
  });

  return [...new Set(issues)];
}

function evaluateReleaseGateState({ qc, partsCount, partStates, cuttingGroups, sheetLayout, modelRevision }) {
  const issues = [];
  const details = Array.isArray(qc?.details) ? qc.details : [];

  if (qc && Number.isFinite(Number(modelRevision)) &&
      Number.isFinite(Number(qc.modelRevision)) &&
      Number(qc.modelRevision) !== Number(modelRevision)) {
    issues.push("Construction QC относится к другой ревизии модели.");
  }

  if (!qc) issues.push("Construction QC не выполнен.");
  if (qc && qc.status !== "PASS") issues.push("Construction QC имеет статус REVIEW.");
  if (!(partsCount > 0)) issues.push("Нет деталей проекта.");
  if (Array.isArray(partStates) && Number(partsCount) !== partStates.length) {
    issues.push("Количество состояний деталей не соответствует количеству деталей проекта.");
  }
  if (qc?.details?.length && Array.isArray(partStates) && qc.details.length !== partStates.length) {
    issues.push("Construction QC не содержит полный состав деталей проекта.");
  }

  (partStates || []).forEach(state => {
    const id = state.number || state.name || "без номера";
    if (!state.detailing) {
      issues.push("Деталь " + id + ": отсутствует detailing.");
      return;
    }
    if (state.detailing.status !== "ready") {
      issues.push("Деталь " + (state.detailing.number || id) + ": detailing не готов.");
    }
    if (Number.isFinite(Number(modelRevision)) &&
        Number.isFinite(Number(state.detailing.modelRevision)) &&
        Number(state.detailing.modelRevision) !== Number(modelRevision)) {
      issues.push("Деталь " + (state.detailing.number || id) + ": detailing относится к другой ревизии модели.");
    }
    const c = state.detailing.cutting;
    if (!c || !c.length || !c.width || !c.thickness) {
      issues.push("Деталь " + (state.detailing.number || id) + ": отсутствуют данные раскроя.");
    }
    (state.detailing.holes || []).forEach(hole => {
      if (!Number.isFinite(Number(hole.diameter)) || Number(hole.diameter) <= 0) {
        issues.push("Деталь " + (state.detailing.number || id) + ": некорректный диаметр отверстия.");
      }
      if (!Number.isFinite(Number(hole.depth)) || Number(hole.depth) <= 0) {
        issues.push("Деталь " + (state.detailing.number || id) + ": некорректная глубина отверстия.");
      }
    });
    if (state.sourceGeometry === "IFC" && state.geometryLocked !== true) {
      issues.push("Деталь " + (state.detailing.number || id) + ": IFC-геометрия не зафиксирована.");
    }
    if (state.detailing.construction?.source &&
        state.sourceGeometry &&
        state.detailing.construction.source !== state.sourceGeometry) {
      issues.push("Деталь " + (state.detailing.number || id) + ": источник геометрии деталировки не соответствует источнику модели.");
    }
  });

  let groups = Array.isArray(cuttingGroups) ? cuttingGroups : [];
  if (!issues.length) {
    if (!groups.length) {
      issues.push("Не сформированы группы раскроя.");
    }
    groups.forEach(group => {
      if (!group.material || !group.thickness || !group.details?.length) {
        issues.push("Группа раскроя содержит неполные данные.");
      }
      (group.details || []).forEach(detail => {
        if (!detail.number || !detail.length || !detail.width || !detail.quantity) {
          issues.push("В группе раскроя есть деталь без полного состава данных.");
        }
      });
    });
  }

  if (!issues.length) {
    issues.push(...validateSheetLayout(sheetLayout));

    // Проверяем, что раскладка содержит ровно тот состав деталей,
    // который был сформирован из согласованной деталировки.
    const expected = new Map();
    groups.forEach(group => {
      (group.details || []).forEach(detail => {
        const key = group.groupNumber + "::" + detail.number;
        expected.set(key, (expected.get(key) || 0) + Math.max(1, Number(detail.quantity || 1)));
      });
    });

    const actual = new Map();
    const expectedDetailByKey = new Map();
    groups.forEach(group => {
      (group.details || []).forEach(detail => {
        expectedDetailByKey.set(group.groupNumber + "::" + detail.number, detail);
      });
    });

    (sheetLayout?.sheets || []).forEach(sheet => {
      (sheet.placements || []).forEach(placement => {
        const key = placement.groupNumber + "::" + placement.partNumber;
        actual.set(key, (actual.get(key) || 0) + 1);
        const expectedDetail = expectedDetailByKey.get(key);
        if (!expectedDetail) return;

        if (Number(placement.length) !== Number(expectedDetail.length) ||
            Number(placement.width) !== Number(expectedDetail.width) ||
            Number(placement.thickness || sheet.thickness) !== Number(expectedDetail.thickness)) {
          issues.push("Раскладка содержит размеры детали, не соответствующие деталировке " + key + ".");
        }
        if (placement.material && expectedDetail.material &&
            placement.material !== expectedDetail.material) {
          issues.push("Раскладка содержит материал, не соответствующий деталировке " + key + ".");
        }
        const expectedEdges = Array.isArray(expectedDetail.edges) ? expectedDetail.edges : [];
        const actualEdges = Array.isArray(placement.edges) ? placement.edges : [];
        if (JSON.stringify(actualEdges) !== JSON.stringify(expectedEdges)) {
          issues.push("Раскладка содержит кромку, не соответствующую деталировке " + key + ".");
        }
      });
    });

    expected.forEach((count, key) => {
      if ((actual.get(key) || 0) !== count) {
        issues.push("Раскладка не соответствует количеству детали " + key + ".");
      }
    });
    actual.forEach((count, key) => {
      if (!expected.has(key)) {
        issues.push("В раскладке присутствует лишняя деталь " + key + ".");
      }
    });
  }

  return {
    gate: "RELEASE",
    status: issues.length ? "BLOCKED" : "PASS",
    passed: issues.length === 0,
    constructionQC: qc?.status || "MISSING",
    checks: {
      constructionQC: !!qc && qc.status === "PASS",
      detailing: partsCount > 0 && (partStates || []).every(state => state.detailing?.status === "ready"),
      cuttingLink: groups.length > 0 && groups.every(group =>
        group.details?.every(detail => detail.number && detail.length && detail.width && detail.quantity)
      ),
      ifcGeometryLocked: (partStates || []).filter(state => state.sourceGeometry === "IFC")
        .every(state => state.geometryLocked === true)
    },
    issueCount: issues.length,
    issues,
    details,
    cuttingGroupsCount: groups.length,
    sheetLayoutChecked: !!sheetLayout,
    sheetCount: sheetLayout?.sheets?.length || 0
  };
}

export { validateSheetLayout, evaluateReleaseGateState };
