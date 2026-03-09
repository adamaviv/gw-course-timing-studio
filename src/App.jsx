import { useMemo, useState } from 'react';

const EXAMPLE_URL =
  'https://my.gwu.edu/mod/pws/print.cfm?campId=1&termId=202601&subjId=CSCI';

const DAYS = [
  { code: 'M', label: 'Mon' },
  { code: 'T', label: 'Tue' },
  { code: 'W', label: 'Wed' },
  { code: 'R', label: 'Thu' },
  { code: 'F', label: 'Fri' },
  { code: 'S', label: 'Sat' },
  { code: 'U', label: 'Sun' },
];

function hashString(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function minuteLabel(totalMinutes) {
  const hour24 = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  const period = hour24 >= 12 ? 'PM' : 'AM';
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${String(minute).padStart(2, '0')} ${period}`;
}

function baseCourseKey(course) {
  const first = String(course.courseNumber ?? '')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)[0];
  const match = first.match(/([A-Z]+)\s*(\d{4})/);
  if (match) {
    return `${match[1]} ${match[2]}`;
  }
  return first || String(course.title ?? '');
}

function colorForCourse(course) {
  const base = baseCourseKey(course);
  const hue = hashString(base) % 360;
  const status = String(course.status ?? '').toUpperCase();
  const isLab = String(course.title ?? '').toLowerCase().includes('(lab)');

  let saturation = isLab ? 45 : 68;
  let lightness = isLab ? 44 : 38;

  if (status.includes('WAIT')) {
    lightness += 10;
  }
  if (status.includes('CLOSED') || status.includes('CANCEL')) {
    saturation = 8;
    lightness = 58;
  }

  return `hsl(${hue} ${saturation}% ${lightness}%)`;
}

function summarizeMeetings(course) {
  if (!course.meetings || course.meetings.length === 0) {
    return 'No scheduled meeting time';
  }

  const byRange = new Map();
  for (const meeting of course.meetings) {
    const key = `${meeting.startLabel}-${meeting.endLabel}`;
    const existing = byRange.get(key) ?? [];
    existing.push(meeting.day);
    byRange.set(key, existing);
  }

  return [...byRange.entries()]
    .map(([range, days]) => `${days.join('')}: ${range}`)
    .join(' | ');
}

function registrationDetailsForCourse(course) {
  if (Array.isArray(course.registrationDetails) && course.registrationDetails.length > 0) {
    return course.registrationDetails;
  }
  return [
    {
      courseNumber: course.courseNumber || 'Course',
      sections: course.section ? [course.section] : [],
      crns: course.crn ? [course.crn] : [],
    },
  ];
}

function crnSummary(course) {
  const crns = [
    ...new Set(
      registrationDetailsForCourse(course)
        .flatMap((detail) => detail.crns ?? [])
        .filter(Boolean)
    ),
  ];
  if (crns.length === 0) {
    return 'CRN: N/A';
  }
  if (crns.length === 1) {
    return `CRN: ${crns[0]}`;
  }
  return `CRNs: ${crns.join(', ')}`;
}

function listingSummary(course) {
  return registrationDetailsForCourse(course)
    .map((detail) => {
      const sections = (detail.sections ?? []).filter(Boolean);
      const crns = (detail.crns ?? []).filter(Boolean);
      const sectionText = sections.length ? `Sec ${sections.join(', ')}` : 'Sec N/A';
      const crnText = crns.length ? `CRN ${crns.join(', ')}` : 'CRN N/A';
      return `${detail.courseNumber}: ${sectionText}, ${crnText}`;
    })
    .join(' | ');
}

function commentEntriesForCourse(course) {
  if (Array.isArray(course.commentDetails) && course.commentDetails.length > 0) {
    return course.commentDetails
      .map((entry) => ({
        courseNumber: String(entry.courseNumber || '').trim() || 'Course',
        text: String(entry.text || '').trim(),
      }))
      .filter((entry) => entry.text);
  }

  return (course.scheduleDetails ?? [])
    .map((text) => String(text || '').trim())
    .filter(Boolean)
    .map((text) => ({
      courseNumber: String(course.courseNumber || '').trim() || 'Course',
      text,
    }));
}

function titleEntriesForCourse(course) {
  if (Array.isArray(course.titleDetails) && course.titleDetails.length > 0) {
    return course.titleDetails
      .map((entry) => ({
        courseNumber: String(entry.courseNumber || '').trim() || 'Course',
        title: String(entry.title || '').trim(),
      }))
      .filter((entry) => entry.title);
  }

  return [
    {
      courseNumber: String(course.courseNumber || '').trim() || 'Course',
      title: String(course.title || '').trim() || 'Untitled',
    },
  ];
}

function instructorEntriesForCourse(course) {
  if (Array.isArray(course.instructorDetails) && course.instructorDetails.length > 0) {
    return course.instructorDetails
      .map((entry) => ({
        courseNumber: String(entry.courseNumber || '').trim() || 'Course',
        instructor: String(entry.instructor || '').trim() || 'TBA',
      }))
      .filter((entry) => entry.instructor);
  }

  return [
    {
      courseNumber: String(course.courseNumber || '').trim() || 'Course',
      instructor: String(course.instructor || '').trim() || 'TBA',
    },
  ];
}

function overlaps(a, b) {
  return a.startMin < b.endMin && b.startMin < a.endMin;
}

function layoutDayEvents(events) {
  if (events.length === 0) {
    return [];
  }

  const sorted = [...events].sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  const clusters = [];
  let currentCluster = [];
  let clusterEnd = -1;

  for (const event of sorted) {
    if (currentCluster.length === 0 || event.startMin < clusterEnd) {
      currentCluster.push(event);
      clusterEnd = Math.max(clusterEnd, event.endMin);
    } else {
      clusters.push(currentCluster);
      currentCluster = [event];
      clusterEnd = event.endMin;
    }
  }

  if (currentCluster.length > 0) {
    clusters.push(currentCluster);
  }

  const positioned = [];

  for (const cluster of clusters) {
    const columns = [];
    const placed = [];

    for (const event of cluster) {
      let columnIndex = -1;
      for (let i = 0; i < columns.length; i += 1) {
        if (columns[i] <= event.startMin) {
          columnIndex = i;
          break;
        }
      }

      if (columnIndex === -1) {
        columns.push(event.endMin);
        columnIndex = columns.length - 1;
      } else {
        columns[columnIndex] = event.endMin;
      }

      placed.push({ ...event, columnIndex });
    }

    const columnCount = Math.max(1, columns.length);
    for (const event of placed) {
      positioned.push({
        ...event,
        leftPct: (event.columnIndex / columnCount) * 100,
        widthPct: 100 / columnCount,
      });
    }
  }

  return positioned;
}

function buildCalendar(courses, activeCourseId) {
  const perDay = Object.fromEntries(DAYS.map((d) => [d.code, []]));

  for (const course of courses) {
    const color = colorForCourse(course);
    for (const meeting of course.meetings ?? []) {
      perDay[meeting.day].push({
        id: `${course.id}-${meeting.day}-${meeting.startMin}`,
        courseId: course.id,
        courseNumber: course.courseNumber,
        title: course.title,
        section: course.section,
        instructor: course.instructor,
        status: course.status,
        startMin: meeting.startMin,
        endMin: meeting.endMin,
        startLabel: meeting.startLabel,
        endLabel: meeting.endLabel,
        color,
        conflict: false,
        active: course.id === activeCourseId,
      });
    }
  }

  for (const day of DAYS.map((d) => d.code)) {
    const events = perDay[day];
    for (let i = 0; i < events.length; i += 1) {
      for (let j = i + 1; j < events.length; j += 1) {
        if (overlaps(events[i], events[j])) {
          events[i].conflict = true;
          events[j].conflict = true;
        }
      }
    }
    perDay[day] = layoutDayEvents(events);
  }

  return {
    perDay,
    startMin: 8 * 60,
    endMin: 22 * 60,
  };
}

function App() {
  const [url, setUrl] = useState(EXAMPLE_URL);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [payload, setPayload] = useState(null);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [showOnlySelected, setShowOnlySelected] = useState(false);
  const [expandedLinkedParentIds, setExpandedLinkedParentIds] = useState(() => new Set());
  const [activeCourseId, setActiveCourseId] = useState(null);
  const [detailPosition, setDetailPosition] = useState(null);
  const [focusedDayCode, setFocusedDayCode] = useState(null);

  const courses = payload?.courses ?? [];

  const filteredCourses = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) {
      return courses;
    }

    return courses.filter((course) => {
      const haystack = [
        course.courseNumber,
        course.section,
        course.title,
        course.instructor,
        course.status,
        summarizeMeetings(course),
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(term);
    });
  }, [courses, search]);

  const linkedChildrenByParentId = useMemo(() => {
    const mapping = new Map();
    const nonLinkedCourses = courses.filter((course) => course.relationType !== 'linked');
    const parentCrnIndex = new Map();
    for (const parentCourse of nonLinkedCourses) {
      const crns = registrationDetailsForCourse(parentCourse)
        .flatMap((detail) => detail.crns ?? [])
        .map((value) => String(value).trim())
        .filter(Boolean);
      for (const crn of crns) {
        if (!parentCrnIndex.has(crn)) {
          parentCrnIndex.set(crn, parentCourse.id);
        }
      }
    }

    for (const course of courses) {
      if (course.relationType !== 'linked') {
        continue;
      }
      const parentCrn = String(course.linkedParentCrn || '').trim();
      const parentId = parentCrnIndex.get(parentCrn);
      if (!parentId) {
        continue;
      }
      const children = mapping.get(parentId) ?? [];
      children.push(course);
      mapping.set(parentId, children);
    }

    return mapping;
  }, [courses]);

  const primaryListCourses = useMemo(() => filteredCourses.filter((course) => course.relationType !== 'linked'), [filteredCourses]);

  const listRows = useMemo(() => {
    const rows = [];
    for (const course of primaryListCourses) {
      const linkedChildren = linkedChildrenByParentId.get(course.id) ?? [];
      const showLinked = expandedLinkedParentIds.has(course.id);
      const visibleLinkedChildren = showOnlySelected
        ? linkedChildren.filter((linkedCourse) => selectedIds.has(linkedCourse.id))
        : linkedChildren;
      const showPrimary = !showOnlySelected || selectedIds.has(course.id) || (showLinked && visibleLinkedChildren.length > 0);
      if (!showPrimary) {
        continue;
      }

      rows.push({
        course,
        isLinked: false,
        linkedCount: linkedChildren.length,
        linkedExpanded: showLinked,
      });

      if (showLinked) {
        for (const linkedCourse of visibleLinkedChildren) {
          rows.push({
            course: linkedCourse,
            isLinked: true,
            parentId: course.id,
            linkedCount: 0,
            linkedExpanded: false,
          });
        }
      }
    }
    return rows;
  }, [primaryListCourses, linkedChildrenByParentId, expandedLinkedParentIds, showOnlySelected, selectedIds]);

  const visibleListCourses = useMemo(
    () => [...new Map(listRows.map((row) => [row.course.id, row.course])).values()],
    [listRows]
  );

  const selectedCourses = useMemo(
    () => courses.filter((course) => selectedIds.has(course.id)),
    [courses, selectedIds]
  );
  const visibleDays = useMemo(() => {
    const hasSaturday = selectedCourses.some((course) => (course.meetings ?? []).some((meeting) => meeting.day === 'S'));
    const hasSunday = selectedCourses.some((course) => (course.meetings ?? []).some((meeting) => meeting.day === 'U'));
    return DAYS.filter((day) => {
      if (day.code === 'S') {
        return hasSaturday;
      }
      if (day.code === 'U') {
        return hasSunday;
      }
      return true;
    });
  }, [selectedCourses]);
  const effectiveFocusedDayCode = useMemo(
    () => (visibleDays.some((day) => day.code === focusedDayCode) ? focusedDayCode : null),
    [focusedDayCode, visibleDays]
  );
  const displayedDays = useMemo(
    () => (effectiveFocusedDayCode ? visibleDays.filter((day) => day.code === effectiveFocusedDayCode) : visibleDays),
    [effectiveFocusedDayCode, visibleDays]
  );
  const activeCourse = useMemo(
    () => courses.find((course) => course.id === activeCourseId) ?? null,
    [courses, activeCourseId]
  );

  const calendar = useMemo(
    () => buildCalendar(selectedCourses, activeCourseId),
    [selectedCourses, activeCourseId]
  );

  const hourTicks = useMemo(() => {
    const ticks = [];
    for (let t = calendar.startMin; t <= calendar.endMin; t += 60) {
      ticks.push(t);
    }
    return ticks;
  }, [calendar.endMin, calendar.startMin]);

  const pxPerMin = 1.15;
  const bodyHeight = Math.max(520, (calendar.endMin - calendar.startMin) * pxPerMin);

  function calculateDetailPosition(anchorRect) {
    if (!anchorRect || typeof window === 'undefined') {
      return null;
    }

    const gap = 10;
    const padding = 12;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const panelWidth = Math.min(560, viewportWidth - padding * 2);
    const panelMaxHeight = Math.min(620, viewportHeight - padding * 2);

    const rightSideLeft = anchorRect.right + gap;
    const leftSideLeft = anchorRect.left - panelWidth - gap;
    let left = rightSideLeft;

    if (rightSideLeft + panelWidth > viewportWidth - padding) {
      if (leftSideLeft >= padding) {
        left = leftSideLeft;
      } else {
        left = Math.min(viewportWidth - panelWidth - padding, Math.max(padding, anchorRect.left));
      }
    }

    let top = anchorRect.top;
    if (top + panelMaxHeight > viewportHeight - padding) {
      top = Math.max(padding, viewportHeight - panelMaxHeight - padding);
    }

    return {
      left: Math.round(left),
      top: Math.round(top),
      width: Math.round(panelWidth),
      maxHeight: Math.round(panelMaxHeight),
    };
  }

  function closeCourseDetails() {
    setActiveCourseId(null);
    setDetailPosition(null);
  }

  function openCourseDetails(courseId, anchorElement) {
    setActiveCourseId(courseId);
    setDetailPosition(calculateDetailPosition(anchorElement?.getBoundingClientRect?.() ?? null));
  }

  async function analyzeUrl(event) {
    event.preventDefault();
    setError('');
    setLoading(true);

    try {
      const response = await fetch('/api/parse-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.error ?? `Request failed (${response.status})`);
      }

      setPayload(body);
      setSelectedIds(new Set());
      setExpandedLinkedParentIds(new Set());
      closeCourseDetails();
    } catch (requestError) {
      setPayload(null);
      setSelectedIds(new Set());
      setExpandedLinkedParentIds(new Set());
      closeCourseDetails();
      setError(requestError instanceof Error ? requestError.message : 'Unexpected error');
    } finally {
      setLoading(false);
    }
  }

  function toggleCourse(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function selectAllVisible() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      visibleListCourses.forEach((course) => next.add(course.id));
      return next;
    });
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  function selectAllCourses() {
    setSelectedIds(new Set(courses.filter((course) => course.relationType !== 'linked').map((course) => course.id)));
  }

  function toggleLinkedForParent(parentId) {
    setExpandedLinkedParentIds((prev) => {
      const next = new Set(prev);
      if (next.has(parentId)) {
        next.delete(parentId);
      } else {
        next.add(parentId);
      }
      return next;
    });
  }

  return (
    <div className="app-shell">
      <header className="top-panel">
        <div>
          <h1>GW Course Timing Studio</h1>
          <p>
            Paste a GW PWS URL, parse the classes, and compare selected sections on a weekly calendar.
          </p>
        </div>
        <form className="url-form" onSubmit={analyzeUrl}>
          <label htmlFor="url">GW Course List URL</label>
          <div className="url-input-row">
            <input
              id="url"
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder={EXAMPLE_URL}
              required
            />
            <button type="submit" disabled={loading}>
              {loading ? 'Analyzing...' : 'Analyze'}
            </button>
          </div>
          <p className="hint">Example: {EXAMPLE_URL}</p>
        </form>
      </header>

      {error ? <div className="error-box">{error}</div> : null}

      {payload ? (
        <main className="workspace">
          <section className="course-panel">
            <div className="panel-header">
              <h2>
                {payload.meta.subjectLabel} | {payload.meta.termLabel}
              </h2>
              <p>
                {payload.meta.parsedCourseCount} merged courses from {payload.meta.rawRowCount} raw rows
              </p>
            </div>

            <div className="controls">
              <input
                type="search"
                placeholder="Filter course number, title, instructor..."
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <div className="buttons-row">
                <button type="button" onClick={selectAllCourses}>
                  Select All
                </button>
                <button type="button" onClick={selectAllVisible}>
                  Select Visible
                </button>
                <button type="button" onClick={clearSelection}>
                  Clear
                </button>
                <label>
                  <input
                    type="checkbox"
                    checked={showOnlySelected}
                    onChange={(event) => setShowOnlySelected(event.target.checked)}
                  />
                  Show only selected
                </label>
              </div>
            </div>

            <div className="course-list">
              {listRows.map((row) => {
                const course = row.course;
                return (
                <label className={`course-item ${row.isLinked ? 'course-item-linked' : ''}`} key={course.id}>
                  <input
                    type="checkbox"
                    checked={selectedIds.has(course.id)}
                    onChange={() => toggleCourse(course.id)}
                  />
                  <div className="course-content">
                    <button
                      type="button"
                      className="course-info-link course-info-link-top"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        openCourseDetails(course.id, event.currentTarget);
                      }}
                    >
                      Details
                    </button>
                    <div className="course-title-row">
                      <span
                        className="course-swatch"
                        style={{ backgroundColor: colorForCourse(course) }}
                        aria-hidden="true"
                      />
                      <span className="course-code">{course.courseNumber}</span>
                      {course.section ? <span className="course-section">Sec {course.section}</span> : null}
                    </div>
                    <p className="course-name">{course.title}</p>
                    <p className="course-meta">
                      {course.instructor} | {course.status}
                    </p>
                    {new Set(instructorEntriesForCourse(course).map((entry) => entry.instructor)).size > 1 ? (
                      <p className="course-meta course-instructor-breakdown">
                        {instructorEntriesForCourse(course)
                          .map((entry) => `${entry.courseNumber}: ${entry.instructor}`)
                          .join(' | ')}
                      </p>
                    ) : null}
                    <p className="course-meta">{crnSummary(course)}</p>
                    {registrationDetailsForCourse(course).length > 1 ? (
                      <p className="course-meta course-registration-breakdown">{listingSummary(course)}</p>
                    ) : null}
                    <p className="course-meeting">{summarizeMeetings(course)}</p>
                    <div className="course-actions-row">
                      {!row.isLinked && row.linkedCount > 0 ? (
                        <button
                          type="button"
                          className="course-info-link"
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            toggleLinkedForParent(course.id);
                          }}
                        >
                          {row.linkedExpanded ? 'Hide Linked' : 'Show Linked'}
                        </button>
                      ) : null}
                    </div>
                  </div>
                </label>
              )})}
            </div>
          </section>

          <section className="calendar-panel">
            <div className="calendar-header">
              <div className="calendar-header-row">
                <h2>
                  {effectiveFocusedDayCode
                    ? `${displayedDays[0]?.label ?? 'Day'} Layout (${selectedCourses.length} selected)`
                    : `Weekly Layout (${selectedCourses.length} selected)`}
                </h2>
                {effectiveFocusedDayCode ? (
                  <button type="button" className="view-toggle-button" onClick={() => setFocusedDayCode(null)}>
                    Week View
                  </button>
                ) : null}
              </div>
              <p>Events outlined in red overlap with at least one selected class. Click an event for details.</p>
            </div>

            <div className="course-detail-hint">
              Click a calendar block to view full course details and notes. Click outside the detail box or use X to
              close it.
            </div>

            <div className="calendar-shell">
              <div className="time-column" style={{ height: bodyHeight }}>
                {hourTicks.map((tick) => (
                  <div
                    key={`time-${tick}`}
                    className="time-label"
                    style={{ top: (tick - calendar.startMin) * pxPerMin }}
                  >
                    {minuteLabel(tick)}
                  </div>
                ))}
              </div>

              <div
                className="day-columns"
                style={{
                  gridTemplateColumns: `repeat(${displayedDays.length}, minmax(120px, 1fr))`,
                  minWidth: effectiveFocusedDayCode ? '100%' : `${Math.max(560, displayedDays.length * 130)}px`,
                }}
              >
                {displayedDays.map((day) => (
                  <div key={day.code} className="day-column">
                    <button
                      type="button"
                      className={`day-heading day-heading-button ${effectiveFocusedDayCode === day.code ? 'day-heading-active' : ''}`}
                      onClick={() => {
                        setFocusedDayCode((previous) => (previous === day.code ? null : day.code));
                      }}
                    >
                      {day.label}
                    </button>
                    <div className="day-body" style={{ height: bodyHeight }}>
                      {hourTicks.map((tick) => (
                        <div
                          key={`line-${day.code}-${tick}`}
                          className="hour-line"
                          style={{ top: (tick - calendar.startMin) * pxPerMin }}
                        />
                      ))}

                      {(calendar.perDay[day.code] ?? []).map((event) => {
                        const top = (event.startMin - calendar.startMin) * pxPerMin;
                        const height = (event.endMin - event.startMin) * pxPerMin;

                        return (
                          <article
                            key={event.id}
                            className={`event ${event.conflict ? 'event-conflict' : ''} ${event.active ? 'event-active' : ''}`}
                            style={{
                              top,
                              height,
                              left: `${event.leftPct}%`,
                              width: `${event.widthPct}%`,
                              backgroundColor: event.color,
                            }}
                            title={`${event.courseNumber} | ${event.title} | ${event.startLabel} - ${event.endLabel}`}
                            role="button"
                            tabIndex={0}
                            onClick={(mouseEvent) => openCourseDetails(event.courseId, mouseEvent.currentTarget)}
                            onKeyDown={(keyboardEvent) => {
                              if (keyboardEvent.key === 'Enter' || keyboardEvent.key === ' ') {
                                keyboardEvent.preventDefault();
                                openCourseDetails(event.courseId, keyboardEvent.currentTarget);
                              }
                            }}
                          >
                            <p className="event-code">{event.courseNumber}</p>
                            <p className="event-title">{event.title}</p>
                            <p>{event.startLabel}</p>
                            <p>{event.endLabel}</p>
                          </article>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>
        </main>
      ) : null}

      {activeCourse ? (
        <div className="course-detail-overlay" role="presentation" onClick={closeCourseDetails}>
          <aside
            className="course-detail-box"
            role="dialog"
            aria-modal="true"
            aria-label="Course details"
            style={detailPosition ?? undefined}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="detail-title-row">
              <h3>
                {activeCourse.courseNumber}
                {activeCourse.section ? ` | Section ${activeCourse.section}` : ''}
              </h3>
              <button
                type="button"
                className="detail-close-button"
                aria-label="Close details"
                onClick={closeCourseDetails}
              >
                X
              </button>
            </div>
            <p className="detail-course-name">{activeCourse.title}</p>
            <p className="detail-meta">
              <strong>Status:</strong> {activeCourse.status} | <strong>{crnSummary(activeCourse)}</strong> |{' '}
              <strong>Credits:</strong> {activeCourse.credits || 'N/A'}
            </p>
            <p className="detail-meta">
              <strong>Instructor:</strong> {activeCourse.instructor || 'TBA'}
            </p>
            {new Set(instructorEntriesForCourse(activeCourse).map((entry) => entry.instructor)).size > 1 ? (
              <div className="detail-notes">
                <strong>Cross-listed Instructors</strong>
                <ul>
                  {instructorEntriesForCourse(activeCourse).map((entry) => (
                    <li key={`${entry.courseNumber}|${entry.instructor}`}>
                      <strong>{entry.courseNumber}:</strong> {entry.instructor}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <p className="detail-meta">
              <strong>Course/Section/CRN:</strong> {listingSummary(activeCourse)}
            </p>
            {new Set(titleEntriesForCourse(activeCourse).map((entry) => entry.title)).size > 1 ? (
              <div className="detail-notes">
                <strong>Cross-listed Titles</strong>
                <ul>
                  {titleEntriesForCourse(activeCourse).map((entry) => (
                    <li key={`${entry.courseNumber}|${entry.title}`}>
                      <strong>{entry.courseNumber}:</strong> {entry.title}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <p className="detail-meta">
              <strong>Room:</strong> {activeCourse.room || 'N/A'} | <strong>Date Range:</strong>{' '}
              {activeCourse.dateRange || 'N/A'}
            </p>
            <p className="detail-meta">
              <strong>Meeting Pattern:</strong> {summarizeMeetings(activeCourse)}
            </p>
            {commentEntriesForCourse(activeCourse).length ? (
              <div className="detail-notes">
                <strong>Description / Notes</strong>
                <ul>
                  {commentEntriesForCourse(activeCourse).map((entry) => (
                    <li key={`${entry.courseNumber}|${entry.text}`}>
                      <strong>{entry.courseNumber}:</strong> {entry.text}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {activeCourse.detailUrl ? (
              <div className="detail-links">
                <a href={activeCourse.detailUrl} target="_blank" rel="noreferrer">
                  Course Catalog Link
                </a>
              </div>
            ) : null}
          </aside>
        </div>
      ) : null}
    </div>
  );
}

export default App;
