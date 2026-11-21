// Funcionalidad opcional: Exportación PDF del viaje (resumen, itinerario, reservas y presupuesto).
// Se genera 100% en el navegador con jsPDF + AutoTable a partir de los datos persistidos.
import { fmtDate, fmtRange, money, tripDays } from "./components.js";

const TEAL = [14, 124, 134];
const SAND = [244, 162, 89];
const INK = [19, 38, 43];
const MUTED = [93, 113, 119];
const TYPE = { FLIGHT: "Vuelo", HOTEL: "Hotel", ACTIVITY: "Actividad" };
const STATUS = { SIMULADA: "Simulada", PENDIENTE: "Pendiente", CONFIRMADA: "Confirmada", CANCELADA: "Cancelada" };

// jsPDF con fuentes estándar no soporta algunos símbolos: se normalizan.
const clean = (s) => String(s ?? "").replace(/[→]/g, "->").replace(/[–—]/g, "-").replace(/[“”]/g, '"').replace(/ /g, " ");

export function exportTripPdf({ trip, itinerary, reservations = [], weather = null, user = null }) {
  if (!window.jspdf?.jsPDF) throw new Error("No se pudo cargar el generador de PDF.");
  const doc = new window.jspdf.jsPDF({ unit: "pt", format: "a4" });
  const W = doc.internal.pageSize.getWidth();
  const M = 40;
  const currency = trip.currency || "COP";

  // Encabezado
  doc.setFillColor(...TEAL);
  doc.rect(0, 0, W, 110, "F");
  doc.setFillColor(...SAND);
  doc.rect(0, 110, W, 4, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text("TRIPPLANNER AI", M, 34);
  doc.setFontSize(24);
  doc.text(clean(trip.title || `Viaje a ${trip.destination}`), M, 66, { maxWidth: W - 2 * M });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  doc.text(clean(`${trip.origin ? trip.origin + " -> " : ""}${trip.destination}  ·  ${fmtRange(trip.startDate, trip.endDate)}  ·  ${tripDays(trip)} días`), M, 90);

  let y = 140;
  const section = (title) => {
    if (y > 740) { doc.addPage(); y = 50; }
    doc.setTextColor(...TEAL);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text(title.toUpperCase(), M, y);
    doc.setDrawColor(...TEAL);
    doc.setLineWidth(1);
    doc.line(M, y + 5, W - M, y + 5);
    y += 20;
  };
  const tableDefaults = {
    margin: { left: M, right: M },
    styles: { font: "helvetica", fontSize: 9.5, cellPadding: 5, textColor: INK, lineColor: [226, 232, 234], lineWidth: 0.5 },
    headStyles: { fillColor: TEAL, textColor: 255, fontStyle: "bold" },
    alternateRowStyles: { fillColor: [245, 247, 248] },
  };

  // Resumen
  section("Resumen del viaje");
  const activityCost = (itinerary?.days || []).flatMap((d) => d.activities || []).reduce((s, a) => s + (Number(a.estimatedCost) || 0), 0);
  const resSameCurrency = reservations.filter((r) => r.status !== "CANCELADA" && (r.currency || "COP") === currency).reduce((s, r) => s + (Number(r.price) || 0), 0);
  const resOther = reservations.filter((r) => r.status !== "CANCELADA" && r.price != null && (r.currency || "COP") !== currency);
  doc.autoTable({
    ...tableDefaults,
    startY: y,
    theme: "plain",
    styles: { ...tableDefaults.styles, fontSize: 10.5 },
    columnStyles: { 0: { fontStyle: "bold", textColor: MUTED, cellWidth: 150 } },
    body: [
      ["Origen", clean(trip.origin || "—")],
      ["Destino", clean(trip.destination)],
      ["Fechas", clean(`${fmtDate(trip.startDate, { weekday: true })} a ${fmtDate(trip.endDate, { weekday: true })}`)],
      ["Viajeros", String(trip.travelers || 1)],
      ["Presupuesto", clean(trip.budget != null ? money(trip.budget, currency) : "—")],
      ["Estado", clean(trip.status || "PLANIFICADO")],
      ...(trip.preferences?.length ? [["Preferencias", clean(trip.preferences.join(", "))]] : []),
      ...(user?.email ? [["Viajero principal", clean(user.name ? `${user.name} (${user.email})` : user.email)]] : []),
    ],
  });
  y = doc.lastAutoTable.finalY + 16;

  // Presupuesto estimado
  section("Presupuesto estimado");
  const spent = activityCost + resSameCurrency;
  const rows = [
    ["Actividades del itinerario", clean(money(activityCost, currency))],
    [`Reservas en ${currency}`, clean(money(resSameCurrency, currency))],
    ...resOther.map((r) => [clean(`Reserva en ${r.currency}: ${r.title}`), clean(money(r.price, r.currency))]),
    ["Total estimado", clean(money(spent, currency))],
  ];
  if (trip.budget != null) rows.push(["Disponible frente al presupuesto", clean(money(Number(trip.budget) - spent, currency))]);
  doc.autoTable({
    ...tableDefaults,
    startY: y,
    head: [["Concepto", "Valor"]],
    body: rows,
    columnStyles: { 1: { halign: "right", cellWidth: 160 } },
    didParseCell: (d) => { if (d.section === "body" && /^Total|^Disponible/.test(d.row.raw[0])) d.cell.styles.fontStyle = "bold"; },
  });
  y = doc.lastAutoTable.finalY + 6;
  if (resOther.length) {
    doc.setFontSize(8.5); doc.setTextColor(...MUTED);
    doc.text("Las reservas en otra moneda no se suman al total.", M, y + 8);
    y += 14;
  }
  y += 12;

  // Clima
  if (weather?.days?.length) {
    section(`Clima en ${weather.city || trip.destination}`);
    doc.autoTable({
      ...tableDefaults,
      startY: y,
      head: [["Fecha", "Condición", "Máx °C", "Mín °C", "Lluvia"]],
      body: weather.days.map((d) => [
        clean(fmtDate(d.date, { weekday: true })), clean(d.condition + (d.estimated ? " (est.)" : "")),
        d.tempMax != null ? Math.round(d.tempMax) : "—", d.tempMin != null ? Math.round(d.tempMin) : "—",
        d.rainProbability != null ? `${d.rainProbability}%` : d.precipitationMm != null ? `${d.precipitationMm} mm` : "—",
      ]),
    });
    y = doc.lastAutoTable.finalY + 18;
  }

  // Itinerario
  section("Itinerario día a día");
  if (itinerary?.days?.length) {
    for (const day of itinerary.days) {
      if (y > 720) { doc.addPage(); y = 50; }
      doc.setTextColor(...INK); doc.setFont("helvetica", "bold"); doc.setFontSize(11);
      doc.text(clean(`Día ${day.day} · ${fmtDate(day.date, { weekday: true })} — ${day.title}`), M, y);
      y += 6;
      doc.autoTable({
        ...tableDefaults,
        startY: y,
        head: [["Hora", "Actividad", "Lugar", "Costo"]],
        body: (day.activities || []).length
          ? day.activities.map((a) => [clean(a.time || "—"), clean(a.title + (a.description ? `\n${a.description}` : "")), clean(a.location || ""), a.estimatedCost ? clean(money(a.estimatedCost, currency)) : ""])
          : [["", "Día libre", "", ""]],
        columnStyles: { 0: { cellWidth: 45 }, 2: { cellWidth: 120 }, 3: { cellWidth: 85, halign: "right" } },
      });
      y = doc.lastAutoTable.finalY + 14;
    }
    if (itinerary.notes) {
      doc.setFont("helvetica", "italic"); doc.setFontSize(9.5); doc.setTextColor(...MUTED);
      const lines = doc.splitTextToSize(clean(`Notas: ${itinerary.notes}`), W - 2 * M);
      if (y + lines.length * 12 > 800) { doc.addPage(); y = 50; }
      doc.text(lines, M, y); y += lines.length * 12 + 10;
    }
  } else {
    doc.setFont("helvetica", "normal"); doc.setFontSize(10); doc.setTextColor(...MUTED);
    doc.text("Este viaje aún no tiene itinerario.", M, y); y += 20;
  }

  // Reservas
  section("Reservas");
  if (reservations.length) {
    doc.autoTable({
      ...tableDefaults,
      startY: y,
      head: [["Tipo", "Descripción", "Fecha", "Proveedor", "Precio", "Estado", "Código"]],
      body: reservations.map((r) => [
        TYPE[r.type] || r.type, clean(r.title), clean(fmtDate(r.date) + (r.time ? ` ${r.time}` : "")), clean(r.provider || ""),
        r.price != null ? clean(money(r.price, r.currency)) : "—", STATUS[r.status] || r.status, r.confirmationCode || "",
      ]),
      columnStyles: { 4: { halign: "right" } },
    });
    y = doc.lastAutoTable.finalY + 8;
    doc.setFontSize(8.5); doc.setTextColor(...MUTED);
    doc.text("Reservas SIMULADAS: registradas por TripPlanner sin intervención de un proveedor externo. No incluyen datos de pago.", M, y + 8, { maxWidth: W - 2 * M });
  } else {
    doc.setFont("helvetica", "normal"); doc.setFontSize(10); doc.setTextColor(...MUTED);
    doc.text("Sin reservas registradas.", M, y);
  }

  // Pie de página
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFontSize(8); doc.setTextColor(...MUTED); doc.setFont("helvetica", "normal");
    doc.text(clean(`TripPlanner AI · Generado el ${new Date().toLocaleString("es-CO")}`), M, 822);
    doc.text(`${i} / ${pages}`, W - M, 822, { align: "right" });
  }

  const name = `TripPlanner_${clean(trip.destination).replace(/[^\w-]+/g, "_")}_${trip.startDate}.pdf`;
  doc.save(name);
  return name;
}
