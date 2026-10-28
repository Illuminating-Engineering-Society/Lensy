/**
 * The tutorials catalogue — read by /tutorials (src/frontend/tutorials.html)
 * and by the admin dashboard's "Tutorial videos" card.
 *
 * Client, 2026-10-28 (pdfs/Others/Tutorials.pdf): each tutorial gets a
 * permanent URL, its video served from our own server rather than Loom, and
 * the Loom-generated "How-To Guide" in a drop-down below the video.
 *
 * ONE ENTRY PER TUTORIAL:
 *   slug     — the permanent URL is /tutorials/<slug>. NEVER rename a slug once
 *              published: it is the URL in emails and the R2 key of the video
 *              (tutorials/<slug>.mp4). Replacing a video = uploading again to
 *              the same slug in /admin → Maintenance → Tutorial videos.
 *   title    — as the reader sees it.
 *   summary  — one paragraph. Loom's AI wrote these; "This Loom …" became
 *              "This video …" (no Loom branding) and "IS Lighting Library"
 *              became "IES Lighting Library".
 *   loom     — the Loom share URL, used ONLY until a video is uploaded for the
 *              slug. null = not recorded yet ("Coming soon").
 *   guide    — the step-by-step guide: { title, steps: [{ title, t, points }] }.
 *              `t` is the step's timestamp ("1:32"): clicking it seeks the
 *              self-hosted video. A point is a string (**bold** allowed) or
 *              { text, items: [...] } for a nested list. The guides' screenshots
 *              are not reproduced — the timestamp plays that moment instead.
 */
(function () {
  const BROWSERS_DESKTOP = 'Chrome, Firefox, Edge, and Safari';
  const BROWSERS_MOBILE = 'Safari Mobile, Chrome Mobile, or Firefox Mobile';

  window.LENS_TUTORIALS = [
    {
      section: 'Getting started',
      items: [
        {
          slug: 'overview',
          title: 'Lighting Library + IES Lens: Overview',
          summary: 'A short tour of the IES Lighting Library and IES Lens: reading, asking and learning with IES resources.',
          loom: 'https://www.loom.com/share/7fc113be55b04f3588d0f549809c3028',
          guide: null,
        },
        {
          // Not recorded yet (client, 2026-10-28). Title to be confirmed.
          slug: 'transition',
          title: 'Transition to the new Lighting Library',
          summary: null,
          loom: null,
          guide: null,
        },
      ],
    },
    {
      section: 'Memberships and user access',
      items: [
        {
          slug: 'managing-user-access',
          title: 'Managing IES Lighting Library User Access',
          summary: null,
          loom: 'https://www.loom.com/share/d0dc512e5a23449c9287845c3fd959a9',
          guide: null,
        },
        {
          slug: 'university-user-seats',
          title: 'Managing IES Library User Seats for Universities',
          summary: null,
          loom: 'https://www.loom.com/share/48cd129f877f48b898a6c2fdb0f9fa6f',
          guide: null,
        },
      ],
    },
    {
      section: 'Lighting Library documents',
      items: [
        {
          slug: 'viewer-troubleshooting',
          title: 'Troubleshoot Lighting Library Viewer Issues',
          summary: 'This video provides troubleshooting guidance for the IES Lighting Library viewer. It recommends a supported browser: on desktop, Chrome, Firefox, Edge or Safari; on mobile or tablet, Safari Mobile, Chrome Mobile or Firefox Mobile. If the viewer does not load or behaves unexpectedly, first confirm it is open in one of the supported browsers. It also advises against clearing the browser cache and against incognito or private browsing, since those can prevent the viewer from saving or loading content correctly.',
          loom: 'https://loom.com/share/3812c762f999451182d18dc95df94d22',
          guide: {
            title: 'How to Troubleshoot Lighting Library Viewer Browser Issues',
            steps: [
              { title: 'Start with a supported browser', t: '0:00', points: [
                'For the best experience, open the IES Lighting Library viewer in a supported browser.',
                `**Desktop supported browsers:** ${BROWSERS_DESKTOP}.`,
                'If the viewer is not loading or behaving correctly, this is the first thing to check.',
              ] },
              { title: 'Use a supported mobile or tablet browser', t: '0:14', points: [
                'On mobile and tablet devices, use one of the supported mobile browsers.',
                `**Supported mobile browsers:** ${BROWSERS_MOBILE}.`,
                'If the viewer looks broken or fails to load, confirm you are using one of these browsers.',
              ] },
              { title: 'Avoid clearing the browser cache for the Lighting Library', t: '0:31', points: [
                'Do **not** clear the cache in the browser you use for the Lighting Library.',
                'Clearing the cache may remove saved viewer data.',
                'It can also remove saved documents needed for offline access.',
              ] },
              { title: 'Do not use incognito or private browsing mode', t: '0:44', points: [
                'Avoid opening the Lighting Library in incognito, private, or similar browser windows.',
                'These modes can prevent the viewer from saving or loading content properly.',
                'Use a normal browser window instead.',
              ] },
              { title: 'Continue troubleshooting if needed', t: '0:56', points: [
                'After confirming the browser and browsing mode, proceed with any additional troubleshooting steps.',
                'If the issue remains, the problem is likely not caused by browser compatibility or private browsing mode.',
              ] },
            ],
          },
        },
        {
          slug: 'highlighting',
          title: 'Annotations: Highlighting',
          summary: 'This video explains the IES Lighting Library viewer’s annotation tools, focusing on text and freehand highlighting. With an active subscription you will see the Annotate ribbon, with color choices, pen styles and font controls. It covers two highlight methods: a click-and-drag text highlight, and a freehand highlight for non-text areas, each with adjustable color and opacity. Highlight color and opacity can also be changed through the style pop-up or the style tab on the left.',
          loom: 'https://loom.com/share/f55200f551cb4f02a0ca3df41d9174b9',
          guide: {
            title: 'How to Use Annotation Tools in the IES Lighting Library Viewer',
            steps: [
              { title: 'Open the Annotate ribbon in the viewer', t: '0:00', points: [
                'The IES Lighting Library viewer includes a set of annotation tools in the toolbar.',
                'If you have an active subscription, you should see the **Annotate** ribbon in the viewer interface.',
                { text: 'These tools include options for:', items: ['Color selection', 'Pen styles', 'Highlighter thickness', 'Font options', 'Other related controls'] },
              ] },
              { title: 'Use the standard text highlight tool', t: '0:24', points: [
                'Use the first highlighting option for normal text.',
                '**Click and drag** over the text you want to highlight.',
                'Repeat the action as needed to highlight additional text.',
              ] },
              { title: 'Adjust highlight color and opacity', t: '0:35', points: [
                'After creating a highlight, you can change its appearance.',
                { text: 'Use either:', items: ['The **pop-up style tab**, or', 'The **style tab** on the left'] },
                { text: 'From there, select the highlight and choose a new:', items: ['Color', 'Opacity'] },
              ] },
              { title: 'Use the freehand highlight tool for non-text items', t: '0:50', points: [
                'The viewer also includes a **freehand highlight** tool.',
                'This is useful when you need to highlight something that is **not text**.',
                'Click and drag to draw the highlight manually.',
              ] },
              { title: 'Edit the freehand highlight appearance', t: '1:02', points: [
                'Select the freehand highlight you want to modify.',
                'Choose a new color.',
                'Adjust the opacity using the opacity control.',
              ] },
            ],
          },
        },
        {
          slug: 'underlining',
          title: 'Annotations: Underlining',
          summary: 'This video explains underline-style annotations in the web viewer. It describes three options on the Annotate ribbon: standard underline (shortcut U), squiggly underline (shortcut G), and a freehand drawing tool for content that is not selectable text. Click and drag to apply the markup and, as with highlights, select an existing annotation to change its color and opacity from the style options.',
          loom: 'https://loom.com/share/b826ca03683b482f9935aa394ee6d391',
          guide: {
            title: 'How to Use Underline, Squiggly, and Freehand Markup Styles in the Web Viewer',
            steps: [
              { title: 'Understand what underline-style markup is for', t: '0:01', points: [
                'Underline-style markup works similarly to highlights, but uses different visual styles.',
                { text: 'You can use it to:', items: ['Call attention to text', 'Mark content that needs review', 'Visually distinguish different kinds of markup'] },
                { text: 'Available styles include:', items: ['Underline', 'Strikeout', 'Squiggly'] },
              ] },
              { title: 'Open the Annotate ribbon in the web viewer', t: '0:18', points: [
                'If you have an active subscription, the Annotate ribbon should appear in the web viewer interface.',
                'This ribbon contains the markup tools used for underline-style annotations.',
              ] },
              { title: 'Choose an underline style and apply it to text', t: '0:18', points: [
                'Select one of the underline tools from the Annotate ribbon.',
                'The first option is standard underline.',
                'Shortcut: **U**',
                { text: 'To apply it:', items: ['Click and drag across the text you want to mark'] },
              ] },
              { title: 'Use squiggly markup for a different visual style', t: '0:36', points: [
                'The second option is squiggly markup.',
                'Shortcut: **G**',
                { text: 'To apply it:', items: ['Click and drag over the text, just like with underline'] },
              ] },
              { title: 'Use freehand markup for non-text content', t: '0:36', points: [
                'The third option is the freehand drawing tool.',
                'This is useful when the content you want to mark is not selectable text in the document body.',
                'Use it to draw an underline manually where needed.',
              ] },
              { title: 'Customize color and opacity for your markup', t: '0:57', points: [
                'You can change the style settings for any markup you create.',
                'Select a highlight or underline annotation.',
                { text: 'Then open the style tab:', items: ['From the pop-up window, or', 'From the style palette in the Annotate ribbon'] },
                { text: 'From there, choose:', items: ['Color', 'Opacity'] },
              ] },
              { title: 'Apply different colors and opacity levels as needed', t: '1:17', points: [
                'Each markup style can use any color.',
                'Each markup style can also use any opacity.',
                'This lets you visually organize annotations in the way that works best for your review process.',
              ] },
            ],
          },
        },
        {
          slug: 'notes-and-callouts',
          title: 'Annotations: Notes and Callouts',
          summary: 'This video explains how to add and manage in-document feedback in the IES Lighting Library viewer using notes and comments. Notes act like digital sticky notes that appear in the comments panel on their page, can be color coded, and can be searched. It shows adding callouts from the Annotate ribbon, with font, styling, stroke and fill, opacity and reply options similar to Adobe Acrobat, and covers commenting on existing highlights or underlines and using the comments search bar to jump to results, such as the keyword “corridor”.',
          loom: 'https://loom.com/share/aaa83dc3630c45e39f1d242e2b1dbcf1',
          guide: {
            title: 'How to Add, Style, and Search Notes and Comments in the IES Lighting Library Viewer',
            steps: [
              { title: 'Open the annotation tools and choose the Note feature', t: '1:01', points: [
                'In the web viewer, look for the **Annotate** ribbon if you have an active subscription.',
                'Click the **Note** icon, or use the shortcut **N**.',
                'If needed, review the **highlighting** and **underlining** tutorials first, since those can help you create comments more efficiently.',
              ] },
              { title: 'Place a note and add your comment', t: '0:17', points: [
                'Notes behave like digital sticky notes.',
                'Click anywhere on the document to place the note.',
                'Type your feedback into the note pop-up and save it.',
                'The note will appear in the **Comments** panel on the right, linked to the page where it was added.',
              ] },
              { title: 'Customize note appearance with color and opacity', t: '0:38', points: [
                'Use the **palette** icon in the note pop-up to assign a color.',
                'You can also adjust styling from the left-side styling tab.',
                'If needed, change the **opacity** for the note.',
                'The comments panel updates to reflect the selected color.',
              ] },
              { title: 'Use notes to organize and review feedback efficiently', t: '0:27', points: [
                'Notes make it easy to jump between specific feedback items.',
                'You can review multiple comments and search within notes when a document has many annotations.',
                'Comments stay organized in the right-hand panel in document order.',
              ] },
              { title: 'Add a callout annotation for visible on-document feedback', t: '1:51', points: [
                'Select the **Callout** tool from the Annotate ribbon.',
                'Click and drag to place the callout on the document.',
                'Enter your text so it appears directly on top of the document during review.',
                'Callouts are useful when you want feedback to be highly visible.',
              ] },
              { title: 'Format callouts to match your needs', t: '2:09', points: [
                'Callouts offer more styling controls than a basic note.',
                { text: 'You can adjust:', items: ['**Font**', '**Font size**', '**Alignment**', '**Color**', '**Dynamic font size**', '**Stroke color**', '**Style**', '**Fill**', '**Opacity**'] },
                'Use these options to make the callout clear and readable.',
              ] },
              { title: 'Reply to comments and create links from existing annotations', t: '2:43', points: [
                'Comments appear in the right-hand panel and can be replied to, similar to Adobe Acrobat.',
                'You can also click a previously highlighted or underlined item to add a comment.',
                { text: 'From the comment pop-up, you can:', items: ['Add a reply', 'Adjust styling', 'Create a hyperlink to any page in the document'] },
              ] },
              { title: 'Search comments and jump back to specific feedback', t: '3:15', points: [
                'Use the search bar in the comments section to find notes by keyword.',
                'Example: search for **“corridor”** to filter matching comments.',
                'If the comments panel is hidden, click the **Comments** button again to restore it.',
                'Select a search result to jump directly back to that comment in the document.',
              ] },
            ],
          },
        },
        {
          slug: 'text-comments',
          title: 'Annotations: Text Comments',
          summary: 'This video demonstrates how to use the text tool to place typed content directly onto a document: select the Free Text icon or press T, drag a rectangle to create a text box, click away, then format the text with the pop-up style button or the style tab. Font, font size, alignment, dynamic font scaling, font color, border, fill and opacity can all be adjusted. Typed comments are saved in the Comments tab on the right, so they are easy to find again later.',
          loom: 'https://loom.com/share/fa13bad4166f44a3b58a8b56411a3492',
          guide: {
            title: 'How to Add and Format Free Text on a Document',
            steps: [
              { title: 'Open the text tool in the Annotate ribbon', t: '0:01', points: [
                'In the web viewer, look for the **Annotate** ribbon if you have an active subscription.',
                'This section shows how to place **typed text directly onto a document** using the text tool.',
              ] },
              { title: 'Place a free text box on the document', t: '0:15', points: [
                'Select the **Free Text** icon, or use the shortcut **T**.',
                '**Drag a rectangle** on the document where you want the text to appear.',
                'Click away when you’re finished placing the text box.',
              ] },
              { title: 'Format the text appearance', t: '0:15', points: [
                'Use the **pop-up style button** or the **Style** tab on the left side.',
                { text: 'Adjust formatting options such as:', items: ['**Font**', '**Font size**', '**Alignment**', '**Dynamic font scaling**'] },
              ] },
              { title: 'Customize color, border, fill, and opacity', t: '0:39', points: [
                'Change the **font color**.',
                'Add a **border** around the text box.',
                'Apply a **fill** color.',
                'Set the **opacity** for the entire comment.',
              ] },
              { title: 'Add an optional comment and find it later', t: '0:59', points: [
                'If needed, add a **comment** to make the text easier to find later.',
                'Like other comments, it will appear in the **Comments** tab on the right for later viewing.',
              ] },
            ],
          },
        },
        {
          slug: 'shapes',
          title: 'Annotations: Adding Shapes',
          summary: 'This video explains how to add and format shapes in the IES Lighting Library viewer to highlight areas during review. With an active subscription, the Shapes ribbon offers rectangles, ellipses, arcs, polygons, clouds, lines, polylines and arrows. Click to start a shape and click again to finish, then set its attributes from the pop-up window or the Style tab on the left: color, stroke thickness, stroke style, fill color and opacity. A comment can be added to the shape, and mistakes are removed with the Delete key.',
          loom: 'https://loom.com/share/e4ae0b5dbca74f2a89021f6166a20653',
          guide: {
            title: 'How to Add and Edit Shapes in the IES Lighting Library Viewer',
            steps: [
              { title: 'Open the Shapes tools in the viewer', t: '0:01', points: [
                { text: 'Shapes are used to:', items: ['Call attention to an area', 'Outline content', 'Create visual markers during review'] },
                'In the IES Lighting Library web viewer, the **Shapes** ribbon should be available if you have an active subscription.',
              ] },
              { title: 'Choose a shape type', t: '0:22', points: [
                'Go to the **Shapes** section in the top toolbar.',
                'Select the shape you want to add.',
                { text: 'Available shape tools include:', items: ['Rectangle (**R**)', 'Ellipse (**O**)', 'Arc', 'Polygon', 'Cloud', 'Line', 'Polyline', 'Arrow'] },
              ] },
              { title: 'Draw the shape on the content', t: '0:45', points: [
                'Click once to start placing the shape.',
                'Click again to complete it.',
                'Repeat as needed to add multiple shapes to the content.',
              ] },
              { title: 'Edit shape attributes', t: '1:07', points: [
                'Click any shape to select it.',
                { text: 'Edit its properties using either:', items: ['The pop-up style window, or', 'The **Style** tab on the left side'] },
                { text: 'You can adjust:', items: ['Color', 'Stroke thickness', 'Stroke style', 'Fill color', 'Opacity'] },
              ] },
              { title: 'Add a comment or save the shape', t: '1:22', points: [
                'After styling the shape, click away to finish.',
                'Or open the **Comment** tab to attach a comment to the shape.',
                'Saving the comment also saves the shape annotation.',
              ] },
              { title: 'Delete a shape or comment', t: '1:49', points: [
                { text: 'If you make a mistake or want to remove an annotation:', items: ['Click the **Delete** button, or', 'Press the **Delete** key on your keyboard'] },
                'This works for shapes and other comments as well.',
              ] },
            ],
          },
        },
        {
          slug: 'measure',
          title: 'The Measure Tool',
          summary: 'This video explains how to use the Measure feature in the web viewer to add measurement marks and adjust their settings. It covers distance measurement with selectable scales (including adding a new scale from presets), straight-line and arc measurements, perimeter measurement with multiple clicks, and area measurement for polygons, circles, ovals and squares. It shows how to remove measurements with the Delete button or the Delete key, how to erase annotations, and how to adjust attributes such as color and opacity from the style options.',
          loom: 'https://loom.com/share/ada29d6dafc4402996535da9d7ac7163',
          guide: {
            title: 'How to Use the Measure Feature in the Web Viewer',
            steps: [
              { title: 'Open the Measure tools and understand what they do', t: '0:01', points: [
                'The **Measure** feature adds visual measurement marks to content.',
                { text: 'You can control measurement appearance and behavior, including:', items: ['color', 'opacity', 'stroke thickness', 'scale', 'precision', 'arrow style'] },
                'Use these tools when you need to communicate dimensions clearly during document review.',
                'If you have an active subscription, the **Measure ribbon** appears in the web viewer interface.',
              ] },
              { title: 'Choose the correct scale before measuring', t: '0:29', points: [
                'Different measurement types are available, but the first step is usually selecting the right **scale**.',
                'If the scale you need is not available, you can add a new one.',
                'You can also adjust the scale between **paper units** and **display units**.',
                'Select a preset scale before drawing so the measurement is calculated correctly.',
              ] },
              { title: 'Create a standard distance measurement', t: '0:41', points: [
                'Use the typical **distance measurement** tool for straight-line measurements.',
                { text: 'Steps:', items: ['Click and hold at the starting point.', 'Drag to the ending point.', 'Release to place the measurement.'] },
                'Make sure the scale is set first so the distance displays accurately.',
              ] },
              { title: 'Draw an arc measurement', t: '1:00', points: [
                'Use the **arc measurement** tool for curved distances.',
                { text: 'Steps:', items: ['Click once to start.', 'Click a second time to define the curve.', 'Click a third time along the arc to complete it.'] },
                'If needed, adjust the units or scale before drawing the arc.',
              ] },
              { title: 'Measure perimeter and area shapes', t: '1:32', points: [
                'Use the **perimeter** tool by clicking multiple points around the shape.',
                'When finished, **double-click** to complete the perimeter.',
                'You can hover over the line to view the measurement, which appears in the upper-right corner.',
                { text: 'For **area** measurements:', items: ['Click points to define a polygon.', 'Finish by clicking the final point into the crosshairs.'] },
                { text: 'You can also measure:', items: ['a **circle** by clicking and dragging', 'an **oval** by clicking and dragging', 'a **square** by clicking and dragging'] },
              ] },
              { title: 'Delete measurements or clear annotations', t: '2:17', points: [
                { text: 'Remove a single measurement or multiple measurements by:', items: ['selecting the **Delete** button, or', 'pressing the **Delete** key on your keyboard.'] },
                { text: 'To remove annotations more broadly:', items: ['use **Erase all annotations from this page** to clear the current page', 'use **Erase all annotations from entire document** to clear everything in the file'] },
              ] },
              { title: 'Edit measurement styling and add comments', t: '2:40', points: [
                'You can select any annotation and change its attributes.',
                { text: 'Update styling from either:', items: ['the pop-up style options, or', 'the **Style** tab on the left side.'] },
                { text: 'Common editable attributes include:', items: ['color', 'opacity'] },
                'After selecting a measurement, you can also hover over it and add a **comment**.',
              ] },
            ],
          },
        },
        {
          slug: 'removing-annotations',
          title: 'Annotations: Removing or Restoring',
          summary: 'This video explains how to correct or remove annotations in the web viewer. With an active subscription you will see the Annotate ribbon, where you can undo the most recent annotation, redo to restore one you removed, or use the eraser tool to remove selected markup. It also covers erasing all annotations from a single page or from the entire document, with a confirmation prompt for each.',
          loom: 'https://loom.com/share/4eaf89ec6b8844e998925d3a30f4d045',
          guide: {
            title: 'How to Correct or Remove Annotations in the Web Viewer',
            steps: [
              { title: 'Open the annotation tools in the web viewer', t: '0:02', points: [
                'In the web viewer, look for the **Annotate** ribbon if you have an active subscription.',
                'This ribbon contains the tools used to edit or remove annotations.',
              ] },
              { title: 'Undo or redo recent annotation changes', t: '0:13', points: [
                'Use **Undo** to reverse the most recent annotation action.',
                'Use **Redo** to restore an annotation you just removed.',
                'These options are helpful for quickly correcting recent changes.',
              ] },
              { title: 'Remove selected markup with the eraser tool', t: '0:13', points: [
                'Select the **eraser tool** to remove specific markup.',
                'Use this when you want to delete only certain annotations instead of all of them.',
              ] },
              { title: 'Erase annotations from a single page or the full document', t: '0:28', points: [
                'Use the additional tools at the top to remove annotations in bulk.',
                'Choose **Erase all annotations from this page** to clear only the current page.',
                'Choose **Erase all annotations from the entire document** to clear the whole document.',
              ] },
              { title: 'Confirm the deletion', t: '0:41', points: [
                'After selecting a bulk erase option, click **Yes** to confirm.',
                'This confirmation applies whether you are deleting annotations from one page or from the entire document.',
              ] },
            ],
          },
        },
      ],
    },
  ];
})();
