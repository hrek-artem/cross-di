import { useState } from "react";

const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const monthLabel = new Intl.DateTimeFormat("en", { month: "long", year: "numeric" });
const dateLabel = new Intl.DateTimeFormat("en", { dateStyle: "full" });
const weekdayLabel = new Intl.DateTimeFormat("en", { weekday: "long" });

export default function CalendarPage() {
  const today = new Date();
  const [month, setMonth] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));
  const year = month.getFullYear();
  const number = month.getMonth();
  const offset = (month.getDay() + 6) % 7;
  const days = new Date(year, number + 1, 0).getDate();
  const cellCount = Math.ceil((offset + days) / 7) * 7;

  return (
    <div className="island-calendar-layout">
      <div className="island-calendar-today" aria-label={dateLabel.format(today)}>
        <strong>{today.getDate()}</strong>
        <span>{weekdayLabel.format(today)}</span>
      </div>
      <div className="island-calendar-month-panel">
        <div className="island-calendar-month">
          <button type="button" className="island-widget-button" aria-label="Previous month" onClick={() => setMonth(new Date(year, number - 1, 1))}>‹</button>
          <span>{monthLabel.format(month)}</span>
          <button type="button" className="island-widget-button" aria-label="Next month" onClick={() => setMonth(new Date(year, number + 1, 1))}>›</button>
        </div>
        <div className="island-calendar-grid" aria-label={monthLabel.format(month)}>
          {weekdays.map((day) => <span className="island-calendar-weekday" key={day}>{day}</span>)}
          {Array.from({ length: cellCount }, (_, index) => {
            const date = new Date(year, number, index - offset + 1);
            const isToday = date.toDateString() === today.toDateString();
            return <span key={index} className="island-calendar-day" data-outside={date.getMonth() !== number} aria-current={isToday ? "date" : undefined} title={dateLabel.format(date)}>{date.getDate()}</span>;
          })}
        </div>
      </div>
    </div>
  );
}
