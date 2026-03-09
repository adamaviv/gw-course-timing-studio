import { Fragment, useEffect, useMemo, useState } from 'react';
import { sanitizeDetailUrl } from '../shared/detailUrl.js';

// Update these defaults each scheduling cycle.
const DEFAULT_SELECTION = {
  campusId: '1',
  termId: '202601',
  subjectId: 'CSCI',
};

const TERM_OPTIONS = [
  { id: '202602', label: "Summer '26" },
  { id: '202601', label: "Spring '26" },
  { id: '202503', label: "Fall '25" },
  { id: '202502', label: "Summer '25" },
  { id: '202501', label: "Spring '25" },
  { id: '202403', label: "Fall '24" },
  { id: '202603', label: "Fall '26" },
  { id: '202701', label: "Spring '27" },
  { id: '202702', label: "Summer '27" },
];

const CAMPUS_OPTIONS = [
  { id: '1', label: 'Main Campus' },
  { id: '4', label: 'Mount Vernon Campus' },
  { id: '2', label: 'Virginia Science & Technology Campus' },
  { id: '3', label: 'Off Campus' },
  { id: '6', label: "CCAS Dean's Seminars" },
  { id: '7', label: 'Online Courses' },
  { id: '8', label: 'Corcoran School of the Arts and Design' },
];

const DAYS = [
  { code: 'M', label: 'Mon' },
  { code: 'T', label: 'Tue' },
  { code: 'W', label: 'Wed' },
  { code: 'R', label: 'Thu' },
  { code: 'F', label: 'Fri' },
  { code: 'S', label: 'Sat' },
  { code: 'U', label: 'Sun' },
];
const RECENT_SUBJECTS_STORAGE_KEY = 'gw-course-studio-recent-subjects-v1';
const MAX_RECENT_SUBJECTS = 12;

function normalizeSubjectIdValue(value) {
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

function termLabelForTermId(termId) {
  return TERM_OPTIONS.find((term) => term.id === termId)?.label ?? `Term ${termId}`;
}

function campusLabelForCampusId(campusId) {
  return CAMPUS_OPTIONS.find((campus) => campus.id === campusId)?.label ?? `Campus ${campusId}`;
}

function recentSubjectKey(entry) {
  return `${entry.termId}|${entry.campusId}|${entry.subjectId}`;
}

function sanitizeRecentSubjects(rawEntries) {
  if (!Array.isArray(rawEntries)) {
    return [];
  }

  const partitioned = rawEntries
    .map((entry) => {
      const termId = String(entry?.termId ?? '').trim();
      const campusId = String(entry?.campusId ?? '').trim();
      const subjectId = normalizeSubjectIdValue(entry?.subjectId);
      if (!termId || !campusId || !subjectId) {
        return null;
      }

      return {
        termId,
        campusId,
        subjectId,
        termLabel: String(entry?.termLabel ?? '').trim() || termLabelForTermId(termId),
        campusLabel: String(entry?.campusLabel ?? '').trim() || campusLabelForCampusId(campusId),
        subjectLabel: String(entry?.subjectLabel ?? '').trim() || subjectId,
        pinned: Boolean(entry?.pinned),
        lastUsedAt: String(entry?.lastUsedAt ?? ''),
      };
    })
    .filter(Boolean)
    .reduce(
      (acc, entry) => {
        if (entry.pinned) {
          acc.pinned.push(entry);
        } else {
          acc.unpinned.push(entry);
        }
        return acc;
      },
      { pinned: [], unpinned: [] }
    );
  const ordered = [...partitioned.pinned, ...partitioned.unpinned];
  return ordered.slice(0, MAX_RECENT_SUBJECTS);
}

function buildScheduleUrl(campusId, termId, subjectId) {
  const params = new URLSearchParams({
    campId: String(campusId ?? '').trim(),
    termId: String(termId ?? '').trim(),
    subjId: String(subjectId ?? '').trim().toUpperCase(),
  });
  return `https://my.gwu.edu/mod/pws/print.cfm?${params.toString()}`;
}

function namespaceCourses(courses, frameKey, frameMeta) {
  return (courses ?? []).map((course) => ({
    ...course,
    id: `${frameKey}:${course.id}`,
    frameKey,
    frameSubjectId: frameMeta.subjectId,
    frameSubjectLabel: frameMeta.subjectLabel,
    frameTermId: frameMeta.termId,
    frameTermLabel: frameMeta.termLabel,
    frameCampusId: frameMeta.campusId,
    frameCampusLabel: frameMeta.campusLabel,
  }));
}

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

  if (status.includes('CANCEL')) {
    return 'hsl(12 62% 40%)';
  }

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

function isCancelledCourse(course) {
  return String(course?.status ?? '')
    .toUpperCase()
    .includes('CANCEL');
}

function isSchedulableCourse(course) {
  return !isCancelledCourse(course) && Array.isArray(course?.meetings) && course.meetings.length > 0;
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

function courseLabelWithCrn(course, courseNumber) {
  const normalizedCourseNumber = String(courseNumber || '').trim().toUpperCase();
  if (!normalizedCourseNumber) {
    return 'Course';
  }

  const matchingCrns = [
    ...new Set(
      registrationDetailsForCourse(course)
        .filter((detail) => String(detail.courseNumber || '').trim().toUpperCase() === normalizedCourseNumber)
        .flatMap((detail) => detail.crns ?? [])
        .map((crn) => String(crn || '').trim())
        .filter(Boolean)
    ),
  ];

  if (matchingCrns.length === 0) {
    return courseNumber;
  }

  const crnText = matchingCrns.length === 1 ? `CRN ${matchingCrns[0]}` : `CRNs ${matchingCrns.join(', ')}`;
  return `${courseNumber} (${crnText})`;
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
        campusLabel: String(course.frameCampusLabel || '').trim(),
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
  const [campusId, setCampusId] = useState(DEFAULT_SELECTION.campusId);
  const [termId, setTermId] = useState(DEFAULT_SELECTION.termId);
  const [subjectId, setSubjectId] = useState(DEFAULT_SELECTION.subjectId);
  const [subjectOptions, setSubjectOptions] = useState([]);
  const [subjectOptionsLoading, setSubjectOptionsLoading] = useState(false);
  const [subjectOptionsError, setSubjectOptionsError] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [subjectFrames, setSubjectFrames] = useState([]);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [showOnlySelected, setShowOnlySelected] = useState(false);
  const [showCancelledCourses, setShowCancelledCourses] = useState(false);
  const [expandedLinkedParentIds, setExpandedLinkedParentIds] = useState(() => new Set());
  const [collapsedFrameKeys, setCollapsedFrameKeys] = useState(() => new Set());
  const [recentSubjects, setRecentSubjects] = useState([]);
  const [recentSubjectsLoaded, setRecentSubjectsLoaded] = useState(false);
  const [draggedPinnedKey, setDraggedPinnedKey] = useState(null);
  const [dragOverPinnedKey, setDragOverPinnedKey] = useState(null);
  const [isSelectedFrameCollapsed, setIsSelectedFrameCollapsed] = useState(false);
  const [activeCourseId, setActiveCourseId] = useState(null);
  const [detailPosition, setDetailPosition] = useState(null);
  const [focusedDayCode, setFocusedDayCode] = useState(null);
  const normalizedSubjectId = useMemo(() => normalizeSubjectIdValue(subjectId), [subjectId]);
  const scheduleUrl = useMemo(
    () => buildScheduleUrl(campusId, termId, normalizedSubjectId),
    [campusId, normalizedSubjectId, termId]
  );
  const selectedCampusLabel = useMemo(() => campusLabelForCampusId(campusId), [campusId]);

  useEffect(() => {
    const controller = new AbortController();
    async function loadSubjects() {
      setSubjectOptionsLoading(true);
      setSubjectOptionsError('');
      try {
        const response = await fetch(
          `/api/subjects?campId=${encodeURIComponent(campusId)}&termId=${encodeURIComponent(termId)}`,
          { signal: controller.signal }
        );
        const body = await response.json();
        if (!response.ok) {
          if (response.status === 422) {
            throw new Error(
              body.error ?? 'No subjects are published yet for this term/campus. Try another term or campus.'
            );
          }
          throw new Error(body.error ?? `Failed to load subjects (${response.status})`);
        }

        const options = Array.isArray(body.subjects)
          ? body.subjects
              .map((subject) => ({
                id: String(subject.id || '').trim().toUpperCase(),
                name: String(subject.name || '').trim(),
                label: String(subject.label || '').trim(),
              }))
              .filter((subject) => subject.id)
          : [];

        setSubjectOptions(options);
        setSubjectId((current) => {
          const normalizedCurrent = normalizeSubjectIdValue(current);
          if (options.some((subject) => subject.id === normalizedCurrent)) {
            return normalizedCurrent;
          }
          if (options.length > 0) {
            return options[0].id;
          }
          return normalizedCurrent;
        });
      } catch (requestError) {
        if (controller.signal.aborted) {
          return;
        }
        setSubjectOptions([]);
        setSubjectOptionsError(requestError instanceof Error ? requestError.message : 'Failed to load subjects');
      } finally {
        if (!controller.signal.aborted) {
          setSubjectOptionsLoading(false);
        }
      }
    }

    loadSubjects();
    return () => controller.abort();
  }, [campusId, termId]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    try {
      const parsed = JSON.parse(window.localStorage.getItem(RECENT_SUBJECTS_STORAGE_KEY) || '[]');
      setRecentSubjects(sanitizeRecentSubjects(parsed));
    } catch {
      setRecentSubjects([]);
    } finally {
      setRecentSubjectsLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !recentSubjectsLoaded) {
      return;
    }
    window.localStorage.setItem(RECENT_SUBJECTS_STORAGE_KEY, JSON.stringify(recentSubjects));
  }, [recentSubjects, recentSubjectsLoaded]);

  const selectedTermLabel = useMemo(() => termLabelForTermId(termId), [termId]);
  const orderedRecentSubjects = useMemo(() => {
    const pinned = [];
    const unpinned = [];
    for (const entry of recentSubjects) {
      if (entry.pinned) {
        pinned.push(entry);
      } else {
        unpinned.push(entry);
      }
    }
    return [...pinned, ...unpinned];
  }, [recentSubjects]);
  const firstUnpinnedRecentIndex = useMemo(
    () => orderedRecentSubjects.findIndex((entry) => !entry.pinned),
    [orderedRecentSubjects]
  );
  const courses = useMemo(() => subjectFrames.flatMap((frame) => frame.courses), [subjectFrames]);

  useEffect(() => {
    const validIds = new Set(courses.map((course) => course.id));
    setSelectedIds((prev) => {
      const next = new Set();
      for (const id of prev) {
        if (validIds.has(id)) {
          next.add(id);
        }
      }
      return next;
    });
    setExpandedLinkedParentIds((prev) => {
      const next = new Set();
      for (const id of prev) {
        if (validIds.has(id)) {
          next.add(id);
        }
      }
      return next;
    });
    setActiveCourseId((prev) => (prev && validIds.has(prev) ? prev : null));
  }, [courses]);

  useEffect(() => {
    if (subjectFrames.length === 0) {
      return;
    }
    const hasDifferentTermLoaded = subjectFrames.some((frame) => frame.termId !== termId);
    if (!hasDifferentTermLoaded) {
      return;
    }

    setSubjectFrames([]);
    setSelectedIds(new Set());
    setExpandedLinkedParentIds(new Set());
    setCollapsedFrameKeys(new Set());
    setIsSelectedFrameCollapsed(false);
    closeCourseDetails();
    setError('');
  }, [subjectFrames, termId]);

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
  const isSearchActive = search.trim().length > 0;

  const linkedChildrenByParentId = useMemo(() => {
    const mapping = new Map();
    const nonLinkedCourses = courses.filter((course) => course.relationType !== 'linked');
    const parentCrnIndex = new Map();
    for (const parentCourse of nonLinkedCourses) {
      const frameKey = String(parentCourse.frameKey || '');
      const crns = registrationDetailsForCourse(parentCourse)
        .flatMap((detail) => detail.crns ?? [])
        .map((value) => String(value).trim())
        .filter(Boolean);
      for (const crn of crns) {
        const scopedCrnKey = `${frameKey}|${crn}`;
        if (!parentCrnIndex.has(scopedCrnKey)) {
          parentCrnIndex.set(scopedCrnKey, parentCourse.id);
        }
      }
    }

    for (const course of courses) {
      if (course.relationType !== 'linked') {
        continue;
      }
      const frameKey = String(course.frameKey || '');
      const parentCrn = String(course.linkedParentCrn || '').trim();
      const parentId = parentCrnIndex.get(`${frameKey}|${parentCrn}`);
      if (!parentId) {
        continue;
      }
      const children = mapping.get(parentId) ?? [];
      children.push(course);
      mapping.set(parentId, children);
    }

    return mapping;
  }, [courses]);

  const primaryListCourses = useMemo(
    () =>
      filteredCourses.filter(
        (course) => course.relationType !== 'linked' && (showCancelledCourses || !isCancelledCourse(course))
      ),
    [filteredCourses, showCancelledCourses]
  );

  const listRows = useMemo(() => {
    const rows = [];
    for (const course of primaryListCourses) {
      const linkedChildren = linkedChildrenByParentId.get(course.id) ?? [];
      const showLinked = expandedLinkedParentIds.has(course.id);
      const visibleLinkedChildren = showOnlySelected
        ? linkedChildren.filter((linkedCourse) => selectedIds.has(linkedCourse.id))
        : linkedChildren;
      const showPrimary =
        !showOnlySelected ||
        (isSchedulableCourse(course) && selectedIds.has(course.id)) ||
        (showLinked && visibleLinkedChildren.length > 0);
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

  const listRowsByFrame = useMemo(() => {
    const grouped = new Map();
    for (const row of listRows) {
      const frameKey = String(row.course.frameKey || '');
      const existing = grouped.get(frameKey) ?? [];
      existing.push(row);
      grouped.set(frameKey, existing);
    }
    return grouped;
  }, [listRows]);

  const navigationFrames = useMemo(
    () =>
      subjectFrames.map((frame) => ({
        ...frame,
        rows: listRowsByFrame.get(frame.key) ?? [],
        collapsed: isSearchActive ? false : collapsedFrameKeys.has(frame.key),
      })),
    [subjectFrames, listRowsByFrame, collapsedFrameKeys, isSearchActive]
  );

  const visibleListCourses = useMemo(
    () => [...new Map(listRows.map((row) => [row.course.id, row.course])).values()],
    [listRows]
  );

  const selectedCourses = useMemo(
    () => courses.filter((course) => selectedIds.has(course.id) && isSchedulableCourse(course)),
    [courses, selectedIds]
  );
  const selectedFrameRows = useMemo(() => {
    const rows = selectedCourses.map((course) => ({
      course,
      isLinked: course.relationType === 'linked',
      linkedCount: 0,
      linkedExpanded: false,
    }));
    rows.sort(
      (a, b) =>
        String(a.course.frameSubjectLabel || '').localeCompare(String(b.course.frameSubjectLabel || '')) ||
        String(a.course.courseNumber || '').localeCompare(String(b.course.courseNumber || '')) ||
        String(a.course.section || '').localeCompare(String(b.course.section || ''))
    );
    return rows;
  }, [selectedCourses]);

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
  const isActiveCourseSelected = useMemo(
    () => Boolean(activeCourse && selectedIds.has(activeCourse.id)),
    [activeCourse, selectedIds]
  );
  const activeCourseDetailUrl = activeCourse ? sanitizeDetailUrl(activeCourse.detailUrl) : '';
  const activeCourseCampusLabel = activeCourse
    ? String(activeCourse.frameCampusLabel || '').trim() ||
      campusLabelForCampusId(String(activeCourse.frameCampusId || '').trim())
    : '';

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

  function unselectActiveCourseFromModal() {
    if (!activeCourseId) {
      return;
    }
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.delete(activeCourseId);
      return next;
    });
    closeCourseDetails();
  }

  function openCourseDetails(courseId, anchorElement) {
    setActiveCourseId(courseId);
    setDetailPosition(calculateDetailPosition(anchorElement?.getBoundingClientRect?.() ?? null));
  }

  function recordRecentSubject(entry) {
    setRecentSubjects((prev) => {
      const cleaned = sanitizeRecentSubjects(prev);
      const key = recentSubjectKey(entry);
      const pinned = cleaned.filter((item) => item.pinned);
      const unpinned = cleaned.filter((item) => !item.pinned);
      const pinnedIndex = pinned.findIndex((item) => recentSubjectKey(item) === key);
      const unpinnedIndex = unpinned.findIndex((item) => recentSubjectKey(item) === key);
      const normalizedEntry = { ...entry, lastUsedAt: new Date().toISOString() };

      if (pinnedIndex >= 0) {
        pinned[pinnedIndex] = { ...pinned[pinnedIndex], ...normalizedEntry, pinned: true };
      } else {
        if (unpinnedIndex >= 0) {
          unpinned.splice(unpinnedIndex, 1);
        }
        unpinned.unshift({ ...normalizedEntry, pinned: false });
      }

      return [...pinned, ...unpinned].slice(0, MAX_RECENT_SUBJECTS);
    });
  }

  function removeRecentSubject(entry) {
    const key = recentSubjectKey(entry);
    setRecentSubjects((prev) => prev.filter((item) => recentSubjectKey(item) !== key));
    setDraggedPinnedKey((prev) => (prev === key ? null : prev));
    setDragOverPinnedKey((prev) => (prev === key ? null : prev));
  }

  function togglePinRecentSubject(entry) {
    const key = recentSubjectKey(entry);
    setRecentSubjects((prev) => {
      const cleaned = sanitizeRecentSubjects(prev);
      const pinned = cleaned.filter((item) => item.pinned);
      const unpinned = cleaned.filter((item) => !item.pinned);
      const pinnedIndex = pinned.findIndex((item) => recentSubjectKey(item) === key);
      const unpinnedIndex = unpinned.findIndex((item) => recentSubjectKey(item) === key);

      if (pinnedIndex >= 0) {
        const [item] = pinned.splice(pinnedIndex, 1);
        unpinned.unshift({ ...item, pinned: false, lastUsedAt: new Date().toISOString() });
      } else if (unpinnedIndex >= 0) {
        const [item] = unpinned.splice(unpinnedIndex, 1);
        pinned.unshift({ ...item, pinned: true });
      }

      return [...pinned, ...unpinned].slice(0, MAX_RECENT_SUBJECTS);
    });
  }

  function reorderPinnedRecentSubjects(draggedKey, targetKey) {
    if (!draggedKey || !targetKey || draggedKey === targetKey) {
      return;
    }

    setRecentSubjects((prev) => {
      const cleaned = sanitizeRecentSubjects(prev);
      const pinned = cleaned.filter((item) => item.pinned);
      const unpinned = cleaned.filter((item) => !item.pinned);
      const draggedIndex = pinned.findIndex((item) => recentSubjectKey(item) === draggedKey);
      const targetIndex = pinned.findIndex((item) => recentSubjectKey(item) === targetKey);
      if (draggedIndex < 0 || targetIndex < 0) {
        return cleaned;
      }

      const [moved] = pinned.splice(draggedIndex, 1);
      pinned.splice(targetIndex, 0, moved);
      return [...pinned, ...unpinned].slice(0, MAX_RECENT_SUBJECTS);
    });
  }

  function formatLoadError(requestError) {
    const message = requestError instanceof Error ? requestError.message : 'Unexpected error';
    if (/No course rows were detected/i.test(message)) {
      return 'No classes are currently published for this selection. Try a different term, campus, or subject.';
    }
    return message;
  }

  async function loadSubjectFrame(targetCampusId, targetTermId, targetSubjectId) {
    const normalizedTargetSubjectId = normalizeSubjectIdValue(targetSubjectId);
    if (!normalizedTargetSubjectId) {
      throw new Error('Please select a subject.');
    }

    const hasDifferentTermLoaded = subjectFrames.some((frame) => frame.termId !== targetTermId);
    if (hasDifferentTermLoaded) {
      setSubjectFrames([]);
      setSelectedIds(new Set());
      setExpandedLinkedParentIds(new Set());
      setCollapsedFrameKeys(new Set());
      setIsSelectedFrameCollapsed(false);
      closeCourseDetails();
    }

    const response = await fetch('/api/parse-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: buildScheduleUrl(targetCampusId, targetTermId, normalizedTargetSubjectId) }),
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body.error ?? `Request failed (${response.status})`);
    }

    const frameKey = `${targetTermId}|${targetCampusId}|${normalizedTargetSubjectId}`;
    const frameMeta = {
      key: frameKey,
      subjectId: normalizedTargetSubjectId,
      subjectLabel: body.meta?.subjectLabel || normalizedTargetSubjectId,
      termId: targetTermId,
      termLabel: body.meta?.termLabel || termLabelForTermId(targetTermId),
      campusId: targetCampusId,
      campusLabel: body.meta?.campusLabel || campusLabelForCampusId(targetCampusId),
      parsedCourseCount: Number(body.meta?.parsedCourseCount ?? body.courses?.length ?? 0),
      rawRowCount: Number(body.meta?.rawRowCount ?? body.courses?.length ?? 0),
    };
    const namespacedCourses = namespaceCourses(body.courses ?? [], frameKey, frameMeta);

    setSubjectFrames((prev) => {
      const next = prev.filter((frame) => frame.key !== frameKey);
      next.push({
        ...frameMeta,
        courses: namespacedCourses,
      });
      return next;
    });
    setCollapsedFrameKeys((prev) => {
      const next = new Set(prev);
      next.add(frameKey);
      return next;
    });
    recordRecentSubject({
      termId: targetTermId,
      termLabel: frameMeta.termLabel,
      campusId: targetCampusId,
      campusLabel: frameMeta.campusLabel,
      subjectId: normalizedTargetSubjectId,
      subjectLabel: frameMeta.subjectLabel,
    });
  }

  async function analyzeSchedule(event) {
    event.preventDefault();
    setError('');
    setLoading(true);

    try {
      await loadSubjectFrame(campusId, termId, normalizedSubjectId);
    } catch (requestError) {
      setError(formatLoadError(requestError));
    } finally {
      setLoading(false);
    }
  }

  async function loadRecentSubject(entry) {
    const nextCampusId = String(entry.campusId || '').trim();
    const nextTermId = String(entry.termId || '').trim();
    const nextSubjectId = normalizeSubjectIdValue(entry.subjectId);
    if (!nextCampusId || !nextTermId || !nextSubjectId) {
      return;
    }

    setCampusId(nextCampusId);
    setTermId(nextTermId);
    setSubjectId(nextSubjectId);
    setError('');
    setLoading(true);
    try {
      await loadSubjectFrame(nextCampusId, nextTermId, nextSubjectId);
    } catch (requestError) {
      setError(formatLoadError(requestError));
    } finally {
      setLoading(false);
    }
  }

  function toggleCourse(id) {
    const course = courses.find((entry) => entry.id === id);
    if (!isSchedulableCourse(course)) {
      return;
    }

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
      visibleListCourses
        .filter((course) => isSchedulableCourse(course))
        .forEach((course) => next.add(course.id));
      return next;
    });
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  function selectAllCourses() {
    setSelectedIds(
      new Set(courses.filter((course) => course.relationType !== 'linked' && isSchedulableCourse(course)).map((course) => course.id))
    );
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

  function selectLinkedForParent(parentId) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const linkedCourses = linkedChildrenByParentId.get(parentId) ?? [];
      linkedCourses.filter((course) => isSchedulableCourse(course)).forEach((course) => next.add(course.id));
      return next;
    });
  }

  function unselectLinkedForParent(parentId) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const linkedCourses = linkedChildrenByParentId.get(parentId) ?? [];
      linkedCourses.forEach((course) => next.delete(course.id));
      return next;
    });
  }

  function selectAllInFrame(frameKey) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      courses
        .filter((course) => course.frameKey === frameKey && isSchedulableCourse(course))
        .forEach((course) => next.add(course.id));
      return next;
    });
  }

  function clearFrameSelection(frameKey) {
    const framePrefix = `${frameKey}:`;
    setSelectedIds((prev) => {
      const next = new Set();
      for (const id of prev) {
        if (!String(id).startsWith(framePrefix)) {
          next.add(id);
        }
      }
      return next;
    });
  }

  function toggleSelectAllInFrame(frame) {
    const schedulableCount = frame.courses.filter((course) => isSchedulableCourse(course)).length;
    if (schedulableCount === 0) {
      return;
    }
    const selectedCount = frame.courses.filter(
      (course) => isSchedulableCourse(course) && selectedIds.has(course.id)
    ).length;
    if (selectedCount === schedulableCount) {
      clearFrameSelection(frame.key);
    } else {
      selectAllInFrame(frame.key);
    }
  }

  function toggleFrameCollapsed(frameKey) {
    setCollapsedFrameKeys((prev) => {
      const next = new Set(prev);
      if (next.has(frameKey)) {
        next.delete(frameKey);
      } else {
        next.add(frameKey);
      }
      return next;
    });
  }

  function handleFrameDoubleClick(event, frameKey) {
    if (isSearchActive) {
      return;
    }

    if (event.target?.closest?.('button,input,select,textarea,a,label')) {
      return;
    }

    toggleFrameCollapsed(frameKey);
  }

  function handleSelectedFrameDoubleClick(event) {
    if (event.target?.closest?.('button,input,select,textarea,a,label')) {
      return;
    }
    setIsSelectedFrameCollapsed((prev) => !prev);
  }

  function removeSubjectFrame(frameKey) {
    const framePrefix = `${frameKey}:`;
    setSubjectFrames((prev) => prev.filter((frame) => frame.key !== frameKey));
    setCollapsedFrameKeys((prev) => {
      const next = new Set(prev);
      next.delete(frameKey);
      return next;
    });
    setSelectedIds((prev) => {
      const next = new Set();
      for (const id of prev) {
        if (!String(id).startsWith(framePrefix)) {
          next.add(id);
        }
      }
      return next;
    });
    setExpandedLinkedParentIds((prev) => {
      const next = new Set();
      for (const id of prev) {
        if (!String(id).startsWith(framePrefix)) {
          next.add(id);
        }
      }
      return next;
    });
    setActiveCourseId((prev) => (prev && String(prev).startsWith(framePrefix) ? null : prev));
    setDetailPosition(null);
  }

  function renderCourseRow(row, options = {}) {
    const { showLinkedToggle = true } = options;
    const course = row.course;
    const courseCancelled = isCancelledCourse(course);
    const linkedCourses = !row.isLinked ? linkedChildrenByParentId.get(course.id) ?? [] : [];
    const linkedSchedulableCount = linkedCourses.filter((linkedCourse) => isSchedulableCourse(linkedCourse)).length;
    const linkedSchedulableSelectedCount = linkedCourses.filter(
      (linkedCourse) => isSchedulableCourse(linkedCourse) && selectedIds.has(linkedCourse.id)
    ).length;
    const linkedSelectedCount = linkedCourses.filter((linkedCourse) => selectedIds.has(linkedCourse.id)).length;

    return (
      <label
        className={`course-item ${row.isLinked ? 'course-item-linked' : ''} ${courseCancelled ? 'course-item-cancelled' : ''}`}
        key={course.id}
      >
        <input
          type="checkbox"
          checked={!courseCancelled && selectedIds.has(course.id)}
          disabled={courseCancelled}
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
          {courseCancelled ? <p className="course-meta course-cancelled-note">Cancelled (not schedulable)</p> : null}
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
            {showLinkedToggle && !row.isLinked && row.linkedCount > 0 ? (
              <>
                <button
                  type="button"
                  className="course-info-link"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    selectLinkedForParent(course.id);
                  }}
                  disabled={
                    linkedSchedulableCount === 0 || linkedSchedulableSelectedCount === linkedSchedulableCount
                  }
                >
                  Select Linked
                </button>
                <button
                  type="button"
                  className="course-info-link"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    unselectLinkedForParent(course.id);
                  }}
                  disabled={linkedSelectedCount === 0}
                >
                  Unselect Linked
                </button>
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
              </>
            ) : null}
          </div>
        </div>
      </label>
    );
  }

  return (
    <div className="app-shell">
      <header className="top-panel">
        <div>
          <h1>GW Course Studio</h1>
          <p>
            Select term, campus, and subject to load the GW Schedule of Classes and compare selected sections on a
            weekly calendar.
          </p>
        </div>
        <form className="url-form" onSubmit={analyzeSchedule}>
          <div className="selectors-grid">
            <label htmlFor="term-id">
              Term
              <select id="term-id" value={termId} onChange={(event) => setTermId(event.target.value)} required>
                {TERM_OPTIONS.map((term) => (
                  <option key={term.id} value={term.id}>
                    {term.label}
                  </option>
                ))}
              </select>
            </label>

            <label htmlFor="campus-id">
              Campus
              <select
                id="campus-id"
                value={campusId}
                onChange={(event) => setCampusId(event.target.value)}
                required
              >
                {CAMPUS_OPTIONS.map((campus) => (
                  <option key={campus.id} value={campus.id}>
                    {campus.label}
                  </option>
                ))}
              </select>
            </label>

            <label htmlFor="subject-id">
              Subject {subjectOptionsLoading ? '(loading...)' : ''}
              <input
                id="subject-id"
                type="text"
                list="subject-options"
                value={subjectId}
                onChange={(event) => setSubjectId(normalizeSubjectIdValue(event.target.value))}
                placeholder="e.g., CSCI"
                required
              />
            </label>
          </div>
          <datalist id="subject-options">
            {subjectOptions.map((subject) => (
              <option key={subject.id} value={subject.id}>
                {subject.label || `${subject.id}${subject.name ? ` - ${subject.name}` : ''}`}
              </option>
            ))}
          </datalist>

          <div className="url-input-row">
            <button type="submit" disabled={loading || subjectOptionsLoading || !normalizedSubjectId}>
              {loading ? 'Loading...' : subjectFrames.length > 0 ? 'Add Subject' : 'Load Classes'}
            </button>
          </div>
          <p className="hint">
            Generated URL: <code>{scheduleUrl}</code>
          </p>
          <p className="hint">
            Available subjects for this term/campus: {subjectOptionsLoading ? 'Loading...' : subjectOptions.length}
          </p>
          {subjectOptionsError ? <p className="hint">{subjectOptionsError}</p> : null}
        </form>

        <section className="recent-subjects">
          <div className="recent-subjects-header">
            <h3>Recent Subjects</h3>
          </div>
          <p className="hint">Pinned subjects stay at the top. Drag pinned cards to reorder.</p>
          {orderedRecentSubjects.length === 0 ? (
            <p className="hint">No recent subjects yet.</p>
          ) : (
            <ul className="recent-subject-list">
              {orderedRecentSubjects.map((entry, index) => {
                const entryKey = recentSubjectKey(entry);
                const isPinned = Boolean(entry.pinned);
                const isDropTarget = Boolean(draggedPinnedKey && dragOverPinnedKey === entryKey && draggedPinnedKey !== entryKey);
                const subjectItem = (
                <li
                  key={entryKey}
                  className={`recent-subject-item ${isPinned ? 'recent-subject-item-pinned' : ''} ${isDropTarget ? 'recent-subject-item-drop-target' : ''}`}
                  draggable={isPinned}
                  onDragStart={(event) => {
                    if (!isPinned) {
                      return;
                    }
                    setDraggedPinnedKey(entryKey);
                    setDragOverPinnedKey(null);
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('text/plain', entryKey);
                  }}
                  onDragOver={(event) => {
                    if (!isPinned || !draggedPinnedKey || draggedPinnedKey === entryKey) {
                      return;
                    }
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                    setDragOverPinnedKey(entryKey);
                  }}
                  onDragLeave={() => {
                    setDragOverPinnedKey((prev) => (prev === entryKey ? null : prev));
                  }}
                  onDrop={(event) => {
                    if (!isPinned || !draggedPinnedKey || draggedPinnedKey === entryKey) {
                      return;
                    }
                    event.preventDefault();
                    reorderPinnedRecentSubjects(draggedPinnedKey, entryKey);
                    setDraggedPinnedKey(null);
                    setDragOverPinnedKey(null);
                  }}
                  onDragEnd={() => {
                    setDraggedPinnedKey(null);
                    setDragOverPinnedKey(null);
                  }}
                >
                  <button
                    type="button"
                    className="recent-subject-button"
                    onClick={() => loadRecentSubject(entry)}
                    disabled={loading}
                  >
                    {entry.subjectLabel || entry.subjectId} | {entry.termLabel || termLabelForTermId(entry.termId)} |{' '}
                    {entry.campusLabel || campusLabelForCampusId(entry.campusId)}
                  </button>
                  <button
                    type="button"
                    className={`recent-subject-pin ${isPinned ? 'recent-subject-pin-active' : ''}`}
                    onClick={() => togglePinRecentSubject(entry)}
                    disabled={loading}
                    title={isPinned ? 'Unpin' : 'Pin'}
                    aria-label={isPinned ? 'Unpin subject' : 'Pin subject'}
                  >
                    📌
                  </button>
                  <button
                    type="button"
                    className="recent-subject-remove-circle"
                    onClick={() => removeRecentSubject(entry)}
                    disabled={loading}
                    title="Remove"
                    aria-label={`Remove ${entry.subjectLabel || entry.subjectId} from recent subjects`}
                  >
                    X
                  </button>
                </li>
                );
                if (index === firstUnpinnedRecentIndex && firstUnpinnedRecentIndex > 0) {
                  return (
                    <Fragment key={`${entryKey}-group`}>
                      <li className="recent-subject-line-break">Unpinned</li>
                      {subjectItem}
                    </Fragment>
                  );
                }
                return subjectItem;
              })}
            </ul>
          )}
        </section>
      </header>

      {error ? <div className="error-box">{error}</div> : null}

      {subjectFrames.length > 0 ? (
        <main className="workspace">
          <section className="course-panel">
            <div className="panel-header">
              <h2>
                {selectedTermLabel} | {selectedCampusLabel}
              </h2>
              <p>
                {subjectFrames.length} loaded subjects | {courses.length} merged courses
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
                <label>
                  <input
                    type="checkbox"
                    checked={showCancelledCourses}
                    onChange={(event) => setShowCancelledCourses(event.target.checked)}
                  />
                  Show cancelled
                </label>
              </div>
            </div>

            <p className="hint">Double-Click to expand and collapse subjects</p>

            <div className="subject-frames">
              <section
                className={`subject-frame selected-frame ${isSelectedFrameCollapsed ? 'subject-frame-collapsed' : ''}`}
                onDoubleClick={handleSelectedFrameDoubleClick}
              >
                <div className="subject-frame-header">
                  <h3>Selected</h3>
                  <div className="subject-frame-actions">
                    <span className="subject-frame-count">{selectedFrameRows.length} selected</span>
                    <button
                      type="button"
                      className="course-info-link"
                      onClick={clearSelection}
                      disabled={selectedFrameRows.length === 0}
                    >
                      Unselect All
                    </button>
                  </div>
                </div>
                <p className="subject-frame-meta">
                  Selected classes from all loaded subjects. This frame always stays visible and is not filtered by
                  search.
                </p>
                {!isSelectedFrameCollapsed ? (
                  <div className="course-list">
                    {selectedFrameRows.length === 0 ? (
                      <p className="hint">No classes selected yet.</p>
                    ) : (
                      selectedFrameRows.map((row) => renderCourseRow(row, { showLinkedToggle: false }))
                    )}
                  </div>
                ) : null}
              </section>

              {navigationFrames.map((frame) => {
                const frameSchedulableCount = frame.courses.filter((course) => isSchedulableCourse(course)).length;
                const frameSelectedCount = frame.courses.filter(
                  (course) => isSchedulableCourse(course) && selectedIds.has(course.id)
                ).length;
                const frameAllSelected = frameSchedulableCount > 0 && frameSelectedCount === frameSchedulableCount;

                return (
                <section
                  className={`subject-frame ${frame.collapsed ? 'subject-frame-collapsed' : ''}`}
                  key={frame.key}
                  onDoubleClick={(event) => handleFrameDoubleClick(event, frame.key)}
                >
                  <div className="subject-frame-header">
                    <h3>{frame.subjectLabel}</h3>
                    <div className="subject-frame-actions">
                      <button
                        type="button"
                        className="course-info-link"
                        onClick={() => toggleSelectAllInFrame(frame)}
                        disabled={frameSchedulableCount === 0}
                      >
                        {frameAllSelected ? 'Unselect All' : 'Select All'}
                      </button>
                      <button
                        type="button"
                        className="course-info-link"
                        onClick={() => clearFrameSelection(frame.key)}
                        disabled={frameSelectedCount === 0}
                      >
                        Clear Selections
                      </button>
                      <button
                        type="button"
                        className="course-info-link"
                        onClick={() => removeSubjectFrame(frame.key)}
                      >
                        Remove Subject
                      </button>
                    </div>
                  </div>
                  <p className="subject-frame-meta">
                    {frame.subjectLabel} | {frame.termLabel} | {frame.campusLabel}
                  </p>
                  {!frame.collapsed ? (
                    <>
                      <p className="subject-frame-meta">
                        {frame.parsedCourseCount} merged courses from {frame.rawRowCount} raw rows
                      </p>
                      <div className="subject-frame-controls">
                        <span className="subject-frame-count">
                          {frameSelectedCount} selected
                        </span>
                      </div>

                      <div className="course-list">
                        {frame.rows.length === 0 ? (
                          <p className="hint">No courses match the current filters.</p>
                        ) : (
                          frame.rows.map((row) => renderCourseRow(row))
                        )}
                      </div>
                    </>
                  ) : null}
                </section>
                );
              })}
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
                            title={`${event.courseNumber} | ${event.title} | ${event.startLabel} - ${event.endLabel}${event.campusLabel ? ` | ${event.campusLabel}` : ''}`}
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
                            {event.campusLabel ? (
                              <p className="event-campus">{event.campusLabel}</p>
                            ) : null}
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
            {isActiveCourseSelected ? (
              <div className="detail-action-row">
                <button
                  type="button"
                  className="detail-unselect-button"
                  onClick={unselectActiveCourseFromModal}
                >
                  Unselect from Calendar
                </button>
              </div>
            ) : null}
            <p className="detail-meta">
              <strong>Status:</strong> {activeCourse.status} | <strong>{crnSummary(activeCourse)}</strong> |{' '}
              <strong>Credits:</strong> {activeCourse.credits || 'N/A'}
            </p>
            <p className="detail-meta">
              <strong>Instructor:</strong> {activeCourse.instructor || 'TBA'}
            </p>
            <p className="detail-meta">
              <strong>Campus:</strong> {activeCourseCampusLabel || 'N/A'}
            </p>
            {new Set(instructorEntriesForCourse(activeCourse).map((entry) => entry.instructor)).size > 1 ? (
              <div className="detail-notes">
                <strong>Cross-listed Instructors</strong>
                <ul>
                  {instructorEntriesForCourse(activeCourse).map((entry) => (
                    <li key={`${entry.courseNumber}|${entry.instructor}`}>
                      <strong>{courseLabelWithCrn(activeCourse, entry.courseNumber)}:</strong> {entry.instructor}
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
                      <strong>{courseLabelWithCrn(activeCourse, entry.courseNumber)}:</strong> {entry.title}
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
                      <strong>{courseLabelWithCrn(activeCourse, entry.courseNumber)}:</strong> {entry.text}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {activeCourseDetailUrl ? (
              <div className="detail-links">
                <a href={activeCourseDetailUrl} target="_blank" rel="noreferrer">
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
