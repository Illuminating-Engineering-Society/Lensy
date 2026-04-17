# Lucius MVP: Feature Specification

## Philosophy

Build Lucius as a **modern, AI-enhanced professional tool** for lighting designers and engineers. Don't try to replicate the legacy system—build the system they actually need.

**Core Principles:**
1. **Natural language first** - Professionals shouldn't need to know IES taxonomy
2. **Project-centric** - Everything revolves around real-world projects
3. **Context over data** - Show not just numbers, but why those numbers matter
4. **Export-ready** - Every view can become a client deliverable
5. **Collaborative** - Projects are shared, not siloed

---

## MVP Feature Set

### 1. SEARCH & DISCOVERY

#### 1.1 Natural Language Search
**What it does:**
Users ask questions in plain English and get relevant IES standard recommendations.

**Examples:**
- "spa lighting requirements" → Healthcare: Spas
- "how bright should an office meeting room be?" → Office Spaces: Conference Rooms
- "outdoor restaurant patio" → Outdoor Pedestrian: Outdoor Dining
- "parking garage lighting" → Parking Facilities: Covered Parking

**Technical Implementation:**
- Vector embeddings of all 134 applications
- Semantic search via Cloudflare Vectorize
- Query expansion (synonyms: "spa" = "wellness center" = "massage therapy")
- Fuzzy matching for typos

**UI:**
```
┌────────────────────────────────────────────────────┐
│  🔦 Search IES Standards                           │
│  ┌──────────────────────────────────────────────┐ │
│  │ Ask a question or describe your space...     │ │
│  └──────────────────────────────────────────────┘ │
│           [Search] or press Enter                  │
│                                                    │
│  Try: "spa lighting" • "office building" •        │
│       "outdoor walkway" • "parking garage"         │
└────────────────────────────────────────────────────┘
```

#### 1.2 Multi-Application Queries
**What it does:**
Users can search for multiple spaces at once, perfect for building-wide projects.

**Examples:**
- "office lobby, hallway, conference room, break room, restroom"
- "hospital patient room, corridor, waiting area, nurse station"
- "retail storefront, sales floor, fitting rooms, stockroom"

**Response:**
Returns all matching applications in a single results page with bulk actions.

**UI:**
```
Found 5 applications:

□ Office Lobby (RP-10-20)          [Expand ▼]
□ Office Hallway (RP-10-20)        [Expand ▼]
□ Conference Room (RP-1-24)        [Expand ▼]
□ Break Room (RP-10-20)            [Expand ▼]
□ Restroom (RP-10-20)              [Expand ▼]

[✓ Select All]  [Add Selected to Project (0)]
```

#### 1.3 Smart Filters
**What it does:**
Refine results by common criteria without losing semantic search quality.

**Filters:**
- Indoor / Outdoor / Both
- Standard (RP-1, RP-9, RP-10, RP-43, etc.)
- Category (Commercial, Healthcare, Sports, Outdoor, etc.)
- TM-24 Eligible (spectral adjustment applies)
- Lighting Zone (LZ0-LZ4 for outdoor applications)

**UI:**
```
Search: "restaurant"

Filters:  [Indoor ▼] [All Standards ▼] [All Categories ▼]

Results (8):
- Restaurant: Dining Area (RP-9-23) - Indoor
- Restaurant: Bar Area (RP-9-23) - Indoor
- Restaurant: Kitchen (RP-9-23) - Indoor
- Outdoor Dining (RP-43-25) - Outdoor
...
```

#### 1.4 Related Applications
**What it does:**
For every search result, show similar or complementary applications the user might also need.

**Examples:**
Search "spa" → Related:
- Patient rooms (same standard, similar environment)
- Hotel spas (different standard, same application)
- Massage therapy rooms (semantic similarity)
- Corridors adjacent to spa (building context)

**Algorithm:**
1. Vector similarity (semantic)
2. Same standard (related sections)
3. Same category (building type)
4. Frequently saved together (collaborative filtering)

---

### 2. ILLUMINANCE RESULTS

#### 2.1 Comprehensive Data Display
**What it shows:**
Every piece of data from the 68-column database, formatted for readability.

**Layout:**
```
┌─────────────────────────────────────────────────────────┐
│ Healthcare → Hospitals and Ambulatory Care → Spas       │
│ ANSI/IES RP-9-20, Table A-1, Row 45                    │
│                                                         │
│ APPLICATION TYPE:                                       │
│ • Area Lighting (not task-specific)                    │
│ • Indoor application                                    │
│                                                         │
│ HORIZONTAL ILLUMINANCE:                                 │
│ ┌───────────────────────────────────────────────────┐  │
│ │ Category:        L                                │  │
│ │ Maintained:      75 lux (7.5 fc)                  │  │
│ │ Measured at:     0 meters (floor level)           │  │
│ │ Average/Max/Min: Average                          │  │
│ │ Uniformity:      4:1 (Avg:Min)                    │  │
│ └───────────────────────────────────────────────────┘  │
│                                                         │
│ VERTICAL ILLUMINANCE:                                   │
│ ┌───────────────────────────────────────────────────┐  │
│ │ Category:        K                                │  │
│ │ Maintained:      50 lux (5 fc)                    │  │
│ │ Measured at:     1.52 m (5 ft)                    │  │
│ │ Average/Max/Min: Average                          │  │
│ │ Uniformity:      6:1 (Avg:Min)                    │  │
│ └───────────────────────────────────────────────────┘  │
│                                                         │
│ NOTES:                                                  │
│ • See General Note A-1 for age-related adjustments     │
│ • TM-24 spectral adjustment not applicable             │
│                                                         │
│ [Add to Project] [View in Vitrium] [Export PDF]        │
└─────────────────────────────────────────────────────────┘
```

**For Outdoor Applications, also show:**
```
OUTDOOR LIGHTING GUIDANCE:
┌───────────────────────────────────────────────────┐
│ Lighting Zone:      LZ2 (Low ambient)             │
│ Max Glare Rating:   G2 (BUG system)               │
│ Max Uplight:        U1 (minimal sky glow)         │
│ Curfew Dimming:     50% after 11 PM               │
│ Spectrum Guidance:  CCT ≤ 3000K (warm white)      │
│ Controls:           Dimming + scheduling required │
└───────────────────────────────────────────────────┘
```

#### 2.2 Standard Context (PDF Integration)
**What it shows:**
Relevant excerpt from the actual IES standard explaining the reasoning behind the values.

**Source:**
- Use `Link_Mapping` field to identify section (e.g., "ANSI/IES RP-9-20_3.5")
- Fetch that section from indexed PDF
- Show 1-3 paragraphs of context

**UI:**
```
┌─────────────────────────────────────────────────────────┐
│ 📖 FROM THE STANDARD                                    │
│                                                         │
│ ANSI/IES RP-9-20, Section 3.5: Wellness Facilities     │
│                                                         │
│ Spa and wellness facilities emphasize relaxation and    │
│ comfort over task performance. Lower illuminance levels │
│ are appropriate to create a calming atmosphere while    │
│ maintaining safe navigation and wayfinding.             │
│                                                         │
│ Design considerations:                                  │
│ • Dimmable lighting for adjustable ambiance            │
│ • Warm color temperatures (2700-3000K) preferred       │
│ • Glare control critical for reclining positions       │
│ • Wet location ratings required for all fixtures       │
│ • Consider daylight integration where available        │
│                                                         │
│ [View Full Section 3.5 in Vitrium →]                   │
└─────────────────────────────────────────────────────────┘
```

**Fallback:**
If no `Link_Mapping` exists, show generic context from standard introduction.

#### 2.3 AI-Generated Explanation (Optional)
**What it shows:**
Plain-language summary answering "why these values?" and "how to apply this?"

**Constraints:**
- Max 3 paragraphs
- Must cite specific sections
- No quotes >15 words
- Watermarked
- Requires disclaimer acknowledgment

**UI:**
```
┌─────────────────────────────────────────────────────────┐
│ 💡 AI EXPLANATION                                       │
│                                                         │
│ ⚠️ This is AI-generated content for informational      │
│    purposes only. Always refer to the full standard.    │
│    [Acknowledge and View]                               │
│                                                         │
│ [Collapsed by default - user must click to expand]     │
└─────────────────────────────────────────────────────────┘

After clicking:
┌─────────────────────────────────────────────────────────┐
│ 💡 AI EXPLANATION                                       │
│                                                         │
│ Why 75 lux for spa lighting?                           │
│                                                         │
│ According to ANSI/IES RP-9-20, Section 3.5, spa        │
│ environments prioritize psychological comfort and       │
│ relaxation over visual task performance. The lower     │
│ illuminance of 75 lux (compared to 200-300 lux for    │
│ typical commercial spaces) helps create a calming      │
│ atmosphere while still providing safe navigation.       │
│                                                         │
│ The vertical illuminance of 50 lux at 1.5m supports   │
│ face recognition and social interaction, which are     │
│ important even in relaxation settings.                  │
│                                                         │
│ How to apply this:                                      │
│                                                         │
│ Use dimmable LED fixtures with warm white CCT         │
│ (2700-3000K) to allow staff to adjust lighting based  │
│ on time of day and treatment type. Consider indirect   │
│ or wall-washing techniques to minimize glare for      │
│ clients in reclining positions.                         │
│                                                         │
│ [IES Lucius AI - Not for reproduction]                │
└─────────────────────────────────────────────────────────┘
```

**Toggle:**
User preference to auto-expand AI explanations or keep collapsed by default.

#### 2.4 Footnotes & General Notes
**What it shows:**
All referenced footnotes from the original table, plus general notes (Annex A).

**UI:**
```
┌─────────────────────────────────────────────────────────┐
│ 📋 NOTES & FOOTNOTES                                    │
│                                                         │
│ [1] When a majority of occupants are over 65, double   │
│     the illuminance recommendations.                    │
│                                                         │
│ [2] For tasks requiring high color accuracy, refer to  │
│     ANSI/IES TM-30 for color rendering guidance.       │
│                                                         │
│ GENERAL NOTES (from Annex A):                          │
│                                                         │
│ • Maintained illuminance target values are consensus   │
│   recommendations for minimum, average, or maximum     │
│   maintained illuminance levels...                      │
│   [Full Annex A text]                                  │
│                                                         │
│ [View Full Table in Vitrium →]                         │
└─────────────────────────────────────────────────────────┘
```

---

### 3. PROJECT MANAGEMENT

#### 3.1 Create Project
**What it does:**
Users create a project container for collecting lighting applications.

**Required Fields:**
- Project name
- Location (address or city)

**Optional Fields:**
- Client name
- Client company
- Project type (New Construction, Renovation, Addition, Retrofit)
- Designer name (pre-filled from user profile)
- Designer company (pre-filled from user profile)
- Target codes/standards (IECC, ASHRAE, Title 24, etc.)
- Notes

**UI:**
```
┌─────────────────────────────────────────────────────────┐
│ Create New Project                                      │
│                                                         │
│ Project Name: *                                         │
│ ┌─────────────────────────────────────────────────────┐│
│ │ Wellness Center - 456 Oak St                        ││
│ └─────────────────────────────────────────────────────┘│
│                                                         │
│ Location: *                                             │
│ ┌─────────────────────────────────────────────────────┐│
│ │ 456 Oak Street, Portland, OR 97204                  ││
│ └─────────────────────────────────────────────────────┘│
│                                                         │
│ Client:                                                 │
│ ┌──────────────────────────┐ ┌──────────────────────┐ │
│ │ Jane Smith               │ │ Tranquility Wellness │ │
│ └──────────────────────────┘ └──────────────────────┘ │
│                                                         │
│ Project Type:                                           │
│ ┌─────────────────────────────────────────────────────┐│
│ │ New Construction ▼                                  ││
│ └─────────────────────────────────────────────────────┘│
│                                                         │
│ Designer: Shane Skwarek (S-FX)  [Edit Profile]         │
│                                                         │
│ Notes:                                                  │
│ ┌─────────────────────────────────────────────────────┐│
│ │ LEED Gold target, prioritize daylighting           ││
│ │                                                     ││
│ └─────────────────────────────────────────────────────┘│
│                                                         │
│ [Cancel]  [Create Project]                             │
└─────────────────────────────────────────────────────────┘
```

#### 3.2 Add Applications to Project
**What it does:**
Save illuminance applications from search results to a project.

**Workflow 1: From Search Results (Single)**
```
User searches: "spa lighting"
    ↓
Clicks: [Add to Project]
    ↓
Modal shows:
  ○ Create new project
    [Project name: ____________]
  
  ● Add to existing:
    [Wellness Center - 456 Oak St ▼]
    
  Custom notes (optional):
  [Consider dimmable LED, warm CCT___]
  
  Quantity: [1] spaces
  Room names: [Main Spa____________]
  
  [Cancel] [Add to Project]
```

**Workflow 2: From Search Results (Bulk)**
```
User searches: "office lobby, hallway, conference room"
    ↓
Selects: [✓] Lobby, [✓] Hallway, [✓] Conference Room
    ↓
Clicks: [Add Selected to Project (3)]
    ↓
Same modal, but adds all 3 applications at once
```

**Workflow 3: AI-Suggested Applications**
```
User: "I'm designing a 50,000 sq ft office building"
    ↓
AI suggests typical applications:
  □ Entrance lobby
  □ Reception desk
  □ Open office areas
  □ Private offices
  □ Conference rooms (small)
  □ Conference rooms (large)
  □ Break rooms
  □ Restrooms
  □ Corridors
  □ IT/Server room
  □ Storage
  □ Parking garage
    ↓
User: [✓ Select All] → [Create Project with These]
    ↓
Creates project + adds all 12 applications
```

#### 3.3 View Project Dashboard
**What it shows:**
All applications in a project, organized and actionable.

**UI:**
```
┌────────────────────────────────────────────────────────────┐
│ Wellness Center - 456 Oak St                               │
│ 📍 Portland, OR 97204                                      │
│ 👤 Tranquility Wellness LLC                                │
│ 📅 Created Mar 15, 2026 • Modified Apr 3, 2026            │
│                                                            │
│ ─────────────────────────────────────────────────────────  │
│                                                            │
│ 12 Applications                                            │
│                                                            │
│ [➕ Add More] [📄 Export PDF] [📊 Export Excel]          │
│ [🔗 Share] [⚙️ Settings]                                  │
│                                                            │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                            │
│ Group by: [Space Type ▼]  Sort by: [Alphabetical ▼]      │
│ Filter: [All Standards ▼] [All Types ▼]                   │
│                                                            │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                            │
│ ENTRANCE & PUBLIC AREAS                                    │
│                                                            │
│ □ Entrance Lobby                    RP-10-20  200  100    │
│   ├─ Main Lobby                                           │
│   └─ Qty: 1                                               │
│   [✏️ Edit] [👁️ View Details] [🗑️ Remove]                │
│                                                            │
│ □ Reception Desk                    RP-10-20  300  150    │
│   ├─ Front Desk                                           │
│   └─ Qty: 1                                               │
│   [✏️ Edit] [👁️ View Details] [🗑️ Remove]                │
│                                                            │
│ ─────────────────────────────────────────────────────────  │
│                                                            │
│ WELLNESS & TREATMENT                                       │
│                                                            │
│ □ Spa                               RP-9-20    75   50    │
│   ├─ Main Spa, Treatment 1, Treatment 2                   │
│   ├─ Qty: 3                                               │
│   └─ Notes: Dimmable LED, warm CCT                        │
│   [✏️ Edit] [👁️ View Details] [🗑️ Remove]                │
│                                                            │
│ □ Massage Therapy Rooms             RP-9-20    50   30    │
│   ├─ Therapy 1, Therapy 2, Therapy 3, Therapy 4           │
│   └─ Qty: 4                                               │
│   [✏️ Edit] [👁️ View Details] [🗑️ Remove]                │
│                                                            │
│ [... 8 more applications ...]                             │
│                                                            │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                            │
│ PROJECT SUMMARY                                            │
│                                                            │
│ Total Applications: 12                                     │
│ Total Spaces: 23                                           │
│ Standards Referenced: 3 (RP-9-20, RP-10-20, RP-43-25)    │
│ Avg Horizontal Illuminance: 142 lux                        │
│ Avg Vertical Illuminance: 78 lux                          │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

**Features:**
- **Expand/Collapse:** Click any application to show full details
- **Edit:** Modify quantity, room names, custom notes
- **Remove:** Delete from project (with confirmation)
- **Bulk Actions:** Select multiple → Delete, Move to another project, Export
- **Grouping:** By space type, standard, floor, or custom tags
- **Sorting:** Alphabetical, by lux value, by standard, by date added

#### 3.4 Edit Application in Project
**What it does:**
Customize how an application is used in this specific project.

**Editable Fields:**
- Quantity (how many of this space type)
- Room names/numbers
- Custom notes
- Override values (advanced: user can manually adjust lux if needed)

**UI:**
```
┌─────────────────────────────────────────────────────────┐
│ Edit: Spa (Healthcare)                                  │
│                                                         │
│ From: ANSI/IES RP-9-20, Table A-1                      │
│ Standard Values: 75 lux (H) / 50 lux (V)               │
│                                                         │
│ Quantity: [3] spaces                                    │
│                                                         │
│ Room Names/Numbers:                                     │
│ ┌─────────────────────────────────────────────────────┐│
│ │ Main Spa                                            ││
│ │ Private Treatment Room 1                            ││
│ │ Private Treatment Room 2                            ││
│ └─────────────────────────────────────────────────────┘│
│                                                         │
│ Custom Notes:                                           │
│ ┌─────────────────────────────────────────────────────┐│
│ │ Use dimmable LED with warm CCT (2700K).             ││
│ │ Install dimmer presets: 100% (maintenance),         ││
│ │ 50% (active treatment), 25% (relaxation).           ││
│ └─────────────────────────────────────────────────────┘│
│                                                         │
│ ☐ Override standard values (advanced)                  │
│                                                         │
│ [Cancel] [Save Changes]                                │
└─────────────────────────────────────────────────────────┘
```

**Override Mode (Advanced):**
If checked, allow manual editing of lux values with warning:
```
⚠️ WARNING: You are modifying IES standard recommendations.
   Document your reasoning for code compliance purposes.

Horizontal: [75] lux → [100] lux
Vertical:   [50] lux → [75] lux

Reason for override:
[Client requested brighter environment for daytime operations]

This will be flagged in exports as "Modified from IES Standard"
```

#### 3.5 My Projects List
**What it shows:**
All projects for current user, sortable and filterable.

**UI:**
```
┌────────────────────────────────────────────────────────────┐
│ My Projects (8)                                            │
│                                                            │
│ [➕ New Project]                                           │
│                                                            │
│ Filter: [All ▼] [Active ▼]  Sort: [Recent ▼]             │
│ Search projects: [________________] 🔍                     │
│                                                            │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                            │
│ 📁 Wellness Center - 456 Oak St                           │
│    Portland, OR • Tranquility Wellness LLC                │
│    12 applications • Modified Apr 3, 2026                  │
│    [Open] [Export] [Archive]                               │
│                                                            │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                            │
│ 📁 Office Building - 123 Main St                          │
│    Seattle, WA • TechCorp Inc                              │
│    18 applications • Modified Mar 28, 2026                 │
│    [Open] [Export] [Archive]                               │
│                                                            │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                            │
│ 📁 Warehouse Renovation                                    │
│    Tacoma, WA • LogiServ Warehousing                       │
│    8 applications • Modified Mar 15, 2026                  │
│    [Open] [Export] [Archive]                               │
│                                                            │
│ [... 5 more projects ...]                                 │
│                                                            │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                            │
│ Archived Projects (3) [Show ▼]                            │
└────────────────────────────────────────────────────────────┘
```

---

### 4. EXPORT & DELIVERABLES

#### 4.1 Export to PDF
**What it creates:**
Professional lighting schedule suitable for client deliverables or code submittals.

**Format:**
```
┌────────────────────────────────────────────────────────────┐
│                    LIGHTING SCHEDULE                       │
│              IES Standard Recommendations                  │
│                                                            │
│  PROJECT INFORMATION                                       │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│  Project:     Wellness Center                              │
│  Location:    456 Oak Street, Portland, OR 97204           │
│  Client:      Tranquility Wellness LLC                     │
│  Designer:    Shane Skwarek, S-FX                          │
│  Date:        April 3, 2026                                │
│                                                            │
│  LIGHTING APPLICATIONS                                     │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                            │
│  1. ENTRANCE LOBBY                                         │
│     Standard: ANSI/IES RP-10-20, Table A-1                │
│     Space: Main Lobby                                      │
│                                                            │
│     HORIZONTAL ILLUMINANCE                                 │
│     Category:    M                                         │
│     Maintained:  200 lux (20 fc)                          │
│     Height:      Floor level (0 m)                         │
│     Uniformity:  3:1 (Avg:Min)                            │
│                                                            │
│     VERTICAL ILLUMINANCE                                   │
│     Category:    L                                         │
│     Maintained:  100 lux (10 fc)                          │
│     Height:      1.52 m (5 ft)                            │
│     Uniformity:  4:1 (Avg:Min)                            │
│                                                            │
│  ────────────────────────────────────────────────────────  │
│                                                            │
│  2. SPA                                                    │
│     Standard: ANSI/IES RP-9-20, Table A-1                 │
│     Spaces: Main Spa, Treatment 1, Treatment 2 (Qty: 3)    │
│     Notes: Dimmable LED, warm CCT (2700K)                  │
│                                                            │
│     HORIZONTAL ILLUMINANCE                                 │
│     Category:    L                                         │
│     Maintained:  75 lux (7.5 fc)                          │
│     Height:      Floor level (0 m)                         │
│     Uniformity:  4:1 (Avg:Min)                            │
│                                                            │
│     VERTICAL ILLUMINANCE                                   │
│     Category:    K                                         │
│     Maintained:  50 lux (5 fc)                            │
│     Height:      1.52 m (5 ft)                            │
│     Uniformity:  6:1 (Avg:Min)                            │
│                                                            │
│  [... continues for all 12 applications ...]              │
│                                                            │
│  GENERAL NOTES                                             │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│  [Standard footnotes and Annex A content]                  │
│                                                            │
│  STANDARD REFERENCES                                       │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│  ANSI/IES RP-9-20: Lighting Healthcare Facilities (2020)   │
│  ANSI/IES RP-10-20: Lighting Common Applications (2020)    │
│  ANSI/IES RP-43-25: Lighting Outdoor Pedestrian Apps (2025)│
│                                                            │
│  ────────────────────────────────────────────────────────  │
│                                                            │
│  Prepared by: _______________________  Date: ___________  │
│  Reviewed by: _______________________  Date: ___________  │
│                                                            │
│  This lighting schedule is based on IES standard           │
│  recommendations and should be reviewed by a qualified     │
│  lighting professional for project-specific requirements.  │
│                                                            │
│  Generated by Lucius - IES Standards Assistant             │
│  https://lucius.ies.org                                    │
└────────────────────────────────────────────────────────────┘
```

**Customization Options:**
- Include/exclude AI explanations
- Include/exclude standard context excerpts
- Include/exclude general notes
- Logo upload (company letterhead)
- Custom header/footer text
- Signature blocks

#### 4.2 Export to Excel
**What it creates:**
Spreadsheet with full 68-column data for all applications in project.

**Sheets:**
1. **Summary** - Project metadata and overview
2. **Applications** - All 68 columns for each application
3. **Standards** - List of referenced standards with links
4. **Notes** - All footnotes and general notes

**Sheet 1: Summary**
```
Project Name:    Wellness Center - 456 Oak St
Location:        Portland, OR 97204
Client:          Tranquility Wellness LLC
Designer:        Shane Skwarek, S-FX
Date:            April 3, 2026

Applications:    12
Total Spaces:    23
Standards:       3 (RP-9-20, RP-10-20, RP-43-25)

Average H-Lux:   142
Average V-Lux:   78
```

**Sheet 2: Applications**
```
| App | App_s1 | App_s2 | Standard | Hor_Cat | Hor_Lux | Hor_Fc | Ver_Cat | Ver_Lux | ... (68 cols) | Room_Names | Custom_Notes | Qty |
|-----|--------|--------|----------|---------|---------|--------|---------|---------|---------------|------------|--------------|-----|
| Healthcare | Hospitals | Spas | RP-9-20 | L | 75 | 7.5 | K | 50 | ... | Main Spa, Treatment 1, Treatment 2 | Dimmable LED | 3 |
```

**Use Cases:**
- Import into project management software
- Luminaire selection and calculations
- Energy modeling inputs
- Code compliance documentation

#### 4.3 Export Single Application
**What it does:**
Export just one application (not whole project) as quick reference.

**Formats:**
- PDF (single page)
- PNG/JPG image (for embedding in presentations)
- JSON (for API integration)

**UI:**
```
From any search result:

[Export ▼]
  • PDF
  • Image (PNG)
  • Excel
  • JSON (API)
  • Copy to Clipboard
```

#### 4.4 Print-Optimized View
**What it does:**
Clean, printer-friendly view of project or single application.

**Features:**
- No navigation/buttons
- High-contrast B&W mode
- Page breaks between applications
- Header/footer with page numbers
- Browser print dialog auto-opens

---

### 5. COMPARISON & ANALYSIS

#### 5.1 Compare Standards (Version Diff)
**What it does:**
Show what changed between editions of the same standard.

**Example:**
"What's new in ANSI/IES RP-6-24 compared to RP-6-22?"

**UI:**
```
┌────────────────────────────────────────────────────────────┐
│ Compare: RP-6-22 (2022) → RP-6-24 (2024)                  │
│                                                            │
│ ADDITIONS (New in 2024)                                    │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                            │
│ ✅ Pickleball - Section 6.20                              │
│    New sport added with Class I-IV recommendations         │
│    [View Details →]                                        │
│                                                            │
│ ✅ Futsal - Section 5.11                                  │
│    Modified soccer played indoors on hardcourt             │
│    [View Details →]                                        │
│                                                            │
│ ✅ IES-DSI Five Principles - Section 2.3                  │
│    Environmental and ecological best practices             │
│    [View Details →]                                        │
│                                                            │
│ REVISIONS (Changed in 2024)                                │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                            │
│ 📝 Light Sources - Section 3.5.3                          │
│    BEFORE: Metal halide primary recommendation             │
│    AFTER:  LED primary, removed legacy lamp technologies   │
│    [View Side-by-Side →]                                   │
│                                                            │
│ 📝 Color Temperature - Section 3.6.2                       │
│    BEFORE: 4000-5000K recommended                          │
│    AFTER:  ≤3000K for environmental concerns              │
│    [View Side-by-Side →]                                   │
│                                                            │
│ 📝 Ice Hockey - Section 6.15                               │
│    Clarified uniformity requirements for broadcast          │
│    [View Side-by-Side →]                                   │
│                                                            │
│ EDITORIAL CHANGES                                          │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                            │
│ • Updated figures and diagrams throughout                  │
│ • Reorganized Annex A for clarity                         │
│ • Added calculation examples in Annex B                    │
│ • 18 new references in bibliography                        │
│                                                            │
│ REMOVED (Opt-in only)                                      │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                            │
│ ⚠️ Would you like to see content removed from the         │
│    deprecated version? This is historical context only     │
│    and should not be used as current guidance.             │
│                                                            │
│ [Show Removed Content]                                     │
│                                                            │
│ — Only shown after user clicks [Show Removed Content] —   │
│ ❌ Dog Racing - Section 5.8                               │
│    Removed due to declining industry relevance             │
│    (Appeared in RP-6-22; not in current standard)         │
│                                                            │
│ [Export Comparison Report] [View Full Standards]          │
└────────────────────────────────────────────────────────────┘
```

**Technical Implementation:**
- Store deprecated standards in database (never delete)
- Mark status: `Active` vs `Deprecated`
- Text diff algorithm on indexed sections
- Categorize changes: Added, Revised, Removed, Editorial

#### 5.2 Compare Applications
**What it does:**
Side-by-side comparison of similar applications from different standards.

**Example:**
"Compare spa lighting in RP-9-20 (Healthcare) vs RP-9-23 (Hospitality)"

**UI:**
```
┌────────────────────────────────────────────────────────────┐
│ Compare: Healthcare Spa vs Hotel Spa                       │
│                                                            │
│                Healthcare Spa    Hotel Spa                 │
│                RP-9-20           RP-9-23                   │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                            │
│ Horizontal:    75 lux            100 lux         ⚠️ 33% ↑ │
│ Vertical:      50 lux            75 lux          ⚠️ 50% ↑ │
│ Uniformity:    4:1               3:1                       │
│ CCT Guidance:  2700-3000K        2700-3500K                │
│                                                            │
│ KEY DIFFERENCES:                                           │
│ • Hotel spas slightly brighter for upscale aesthetics      │
│ • Healthcare emphasizes therapeutic environment            │
│ • Both require dimmable controls                           │
│                                                            │
│ [View Full Details] [Add Both to Project]                 │
└────────────────────────────────────────────────────────────┘
```

---

### 6. USER PREFERENCES & SETTINGS

#### 6.1 Unit Preferences
**Options:**
- Lux (metric) vs Footcandles (imperial)
- Meters vs Feet for heights
- Default to: User's choice or "Show Both"

#### 6.2 Display Preferences
**Options:**
- Auto-expand AI explanations (default: collapsed)
- Auto-expand standard context (default: expanded)
- Theme: Light / Dark / Auto
- Compact view (less spacing for power users)

#### 6.3 Export Defaults
**Options:**
- Company logo upload
- Designer name/company (pre-fill)
- Include/exclude AI content by default
- PDF page size (Letter / A4)

#### 6.4 Notification Preferences
**Options:**
- Email when standard updates
- Email when shared project is modified
- Weekly summary of saved searches

---

### 7. COLLABORATION (Future Phase)

#### 7.1 Share Project (Read-Only Link)
**What it does:**
Generate a public link to view (not edit) a project.

**Use Cases:**
- Share with client for review
- Share with team members who don't have IES accounts
- Embed in proposal/RFP

**UI:**
```
┌─────────────────────────────────────────────────────────┐
│ Share: Wellness Center Project                          │
│                                                         │
│ 🔗 Public Link (read-only):                            │
│ ┌─────────────────────────────────────────────────────┐│
│ │ https://lucius.ies.org/shared/abc123xyz            ││
│ └─────────────────────────────────────────────────────┘│
│ [📋 Copy Link]                                          │
│                                                         │
│ Link expires: [7 days ▼] [Never ▼]                     │
│ Require password: ☐ [________]                          │
│                                                         │
│ What can viewers see:                                   │
│ ☑ Project applications and illuminance values           │
│ ☑ Standard references and links                         │
│ ☐ AI explanations (optional)                            │
│ ☐ Your notes and comments                               │
│                                                         │
│ [Cancel] [Generate Link]                               │
└─────────────────────────────────────────────────────────┘
```

#### 7.2 Team Projects (Future)
**What it does:**
Multiple users can collaborate on same project (Google Docs style).

**Features:**
- Invite team members by email
- Real-time updates when others edit
- Comment threads on applications
- Activity log (who added/removed what)
- Role-based permissions (Viewer, Editor, Owner)

---

## Technical Architecture Summary

### Database Schema (Cloudflare D1)

**Applications Table** (from legacy 68-column data)
- 134 applications × 68 columns
- No changes to structure, import as-is

**Projects Table**
```sql
CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  location TEXT,
  client_name TEXT,
  client_company TEXT,
  project_type TEXT,
  designer_name TEXT,
  designer_company TEXT,
  status TEXT DEFAULT 'Active',
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  modified_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**Project Applications Table** (junction)
```sql
CREATE TABLE project_applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  application_code TEXT NOT NULL,
  snapshot_data JSON, -- Full 68 cols as JSON
  quantity INTEGER DEFAULT 1,
  room_names TEXT,
  custom_notes TEXT,
  overridden BOOLEAN DEFAULT 0,
  override_hor_lux REAL,
  override_ver_lux REAL,
  override_reason TEXT,
  added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
```

### Vector Search (Cloudflare Vectorize)

**Index Structure:**
- ID: `application_code` (e.g., "RP-9_A-1_45")
- Vector: 768-dimensional embedding (from Workers AI)
- Metadata: `{standard_code, category, indoor_outdoor, task_or_area}`

**Indexed Text:**
```
Hierarchical name: Healthcare Hospitals and Ambulatory Care Spas
Category: Healthcare, Wellness facilities
Type: Indoor, Area lighting
Notes: Therapeutic environment, relaxation, lower illuminance
Source: ANSI/IES RP-9-20 Table A-1
```

### API Endpoints

```
POST   /api/search                    # Natural language search
GET    /api/applications/:code        # Get single application
GET    /api/standards                 # List all standards
GET    /api/standards/:code/compare   # Compare versions

POST   /api/projects                  # Create project
GET    /api/projects                  # List user's projects
GET    /api/projects/:id              # Get project details
PATCH  /api/projects/:id              # Update project
DELETE /api/projects/:id              # Delete project

POST   /api/projects/:id/applications # Add apps to project
PATCH  /api/projects/:id/applications/:app_id  # Edit app in project
DELETE /api/projects/:id/applications/:app_id  # Remove from project

GET    /api/projects/:id/export       # Export project (PDF/Excel)
POST   /api/projects/:id/share        # Generate share link
```

---

## MVP Success Criteria

### User Adoption
- 500+ searches in first month
- 100+ projects created in first month
- 50+ exports (PDF/Excel) in first month

### Search Quality
- 90%+ of searches return relevant results (manual audit)
- Average 3+ applications per project
- 70%+ of multi-application queries use all results

### Technical Performance
- <500ms average search response time
- <2s PDF generation time
- 99.9% uptime (Cloudflare edge network)

### Business Impact
- 20% increase in Vitrium document views
- 10% increase in IES memberships (attribution)
- Positive feedback from beta testers (>4.0/5.0 rating)

---

## Out of Scope for MVP

### Deferred to Future Phases:
- ❌ Mobile app (web-responsive only for now)
- ❌ Offline mode
- ❌ Custom calculation tools (beyond IES tables)
- ❌ Integration with lighting design software (AGi32, Dialux, etc.)
- ❌ BIM/Revit plugin
- ❌ Multi-language support (English only for MVP)
- ❌ Advanced analytics dashboard
- ❌ AI chatbot (conversational interface beyond search)
- ❌ Photometric data integration
- ❌ Energy modeling calculations
- ❌ Custom template builder (beyond standard exports)

---

## Development Timeline (12 Weeks)

**Weeks 1-2: Data & Infrastructure**
- Import 68-column database to D1
- Generate vector embeddings
- Set up Cloudflare Workers/Pages
- PDF indexing pipeline

**Weeks 3-4: Search & Results**
- Natural language search API
- Results formatting
- Standard context integration
- Related applications algorithm

**Weeks 5-6: Projects Core**
- Create/edit/delete projects
- Add applications to projects
- Project dashboard UI
- Edit applications in projects

**Weeks 7-8: Export & Deliverables**
- PDF export formatting
- Excel export with 68 columns
- Single application export
- Print-optimized views

**Weeks 9-10: AI & Polish**
- Workers AI integration for summaries
- Copyright validation
- UI/UX refinements
- Performance optimization

**Weeks 11-12: Testing & Launch**
- Beta testing with IES members
- Bug fixes and iterations
- Documentation
- Public launch

---

## Conclusion

This MVP focuses on what lighting professionals actually need:
1. **Find** lighting requirements quickly (natural language search)
2. **Understand** why those requirements exist (standard context + AI)
3. **Apply** them to real projects (project management)
4. **Deliver** professional documentation (exports)

Build this well, and Lucius becomes indispensable for anyone specifying lighting.
