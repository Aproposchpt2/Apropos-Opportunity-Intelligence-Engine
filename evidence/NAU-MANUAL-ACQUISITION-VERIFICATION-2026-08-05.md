# Northern Arizona University Manual Acquisition Verification

**Execution date:** 2026-08-05  
**Execution mode:** Isolated read-only machine-to-machine acquisition test  
**Production writes:** None  
**Publisher:** Northern Arizona University  

## Official channels tested

1. Contracts, Purchasing, and Risk Management — Central Bid Board  
   `https://in.nau.edu/contracting-purchasing-services/nau-bid-board/`
2. Facility Services Planning, Design & Construction — Bids and RFQs  
   `https://in.nau.edu/facility-services/pdc/bids-rfqs/`

## Access determination

| Control | Result |
|---|---|
| Listing HTTP status | 200 |
| Listing content type | text/html; charset=UTF-8 |
| Authentication required | No |
| Cookies required | No |
| JavaScript rendering required | No |
| Browser automation required | No |
| Direct document retrieval | Yes |
| HTTP range retrieval | Supported for all 15 tested documents |
| Document MIME verification | 15 of 15 application/pdf |
| PDF signature verification | 15 of 15 valid `%PDF-` |
| SHA-256 fingerprints | 15 of 15 created |
| Acquisition failures | 0 |

The Facility Services listing contained 58,135 bytes of static HTML and 81 directly parseable anchors. The Central Bid Board contained 45,310 bytes of static HTML.

## Portfolio A — Fieldhouse HVAC Replacement

**Project number:** `09.300.251`  
**Observed lifecycle:** Award selection posted; retained as the complete portfolio and addendum verification case.  
**Documents acquired:** 8  
**Addenda acquired:** 3  
**Actual bytes acquired:** 22,531,447  
**Failures:** 0

| Document | Actual bytes | SHA-256 |
|---|---:|---|
| Notice of Bid | 553,114 | `3e1e88ec2b63fefb34c0cbe9b2d9bd9dd408940870cf9bc70327773b7b45c8c7` |
| Project Manual | 10,970,129 | `ee93b83f317106f46628ae7531e10dd99e718852b73b4fc832813bab70b11c4a` |
| Construction Documents | 7,683,774 | `e24245c96ae4889adeef4b4c24c505491f7aba0cac69e9f3f85651546e2332b4` |
| Pre-Submittal Conference Slides | 114,120 | `3e8ab9fffff49727a39a79872b2ab999c3ff1efc3058e29a7023f374939b583c` |
| Addendum #1 | 1,384,780 | `4129393c3f741c26335daca14569f3a5dc7e7fa88a13308dd5cbba7a3b5a638d` |
| Addendum #2 | 281,296 | `505512d93a2a87e31541446a2db919bad75f2289c8c552db639490211bac5d4d` |
| Addendum #3 | 1,255,628 | `81919b518a295cc6d342cc2d46a26f0355aeea74debb5623d7dafd40a8f12c21` |
| Bid Tab Matrix | 288,606 | `10b494424fd26e370023a44dd59767213f965fff0b291b3b6c279baef10867ec` |

## Portfolio B — Annual Request for Qualifications

**Project number:** `11.160.232`  
**Observed lifecycle:** Current open-ended request; NAU states there is no submission deadline.  
**Documents acquired:** 7  
**Actual bytes acquired:** 991,811  
**Failures:** 0

| Document | Actual bytes | SHA-256 |
|---|---:|---|
| Request for Qualifications | 462,943 | `6ab18b052b4c1b7c47816302718f447e529111e0855f5d4801974e6776b489f8` |
| Attachment A | 130,357 | `ef359229d97167e8154578c6b26f02bd710fefc77533f02373cdd2d8275f7c22` |
| Attachment A.1 | 13,666 | `66f5d4713a0d176611577d4c9968e99176e284517e637a350a07a7ed85bee84c` |
| Attachment E.1 | 17,205 | `42df7aeab4900a31354574df8b4ea2c907e2acb00bf47d9c1c8b02d3f850542b` |
| Attachment E.2 | 23,151 | `19b64bfd61583edb80ef41a9f592f1e9072bf36082c6a3f9f8c2cd70c626451d` |
| Attachment E.3 | 51,296 | `35895679285ff6d1c77ad472a581b837baa1989e4c6be04bb1ccdcd145146a71` |
| Exhibit 3 | 293,193 | `58a985d202f9a8d899a880a5db6c3442aa3ef52686216ce43ba3bfe5f300904d` |

## Combined test result

| Metric | Result |
|---|---:|
| Opportunities evaluated | 2 |
| Documents downloaded | 15 |
| Valid PDFs | 15 |
| Range-accessible documents | 15 |
| Actual bytes acquired | 23,523,258 |
| Failures | 0 |

## Acquisition behavior observed

1. NAU operates two separate procurement channels that must be represented under one publisher profile.
2. Both channels are ordinary static HTML and can be acquired with direct server-side HTTPS requests.
3. Facility Services mixes active, awarded, retained, and open-ended opportunities on one page. Presence on the page does not prove an opportunity is open.
4. Lifecycle status must be derived from due dates and the narrative notes attached to each project.
5. The Central Bid Board retained solicitation `P26JN004` even though its displayed due date of May 14, 2026 had passed at test time.
6. The Facility Services page states that the 2023 Annual RFQ remains current. The connector must not infer expiration from an old filename, URL year, or file modification date.
7. Repeated attachment labels such as “Request for Qualifications” and “Pre-submittal conference slides” occur under multiple projects. Document discovery must be scoped to the project container, not performed as an unscoped page-wide label search.
8. Documents are stored as direct WordPress media URLs and provide Content-Length, Last-Modified, ETag, range responses, MIME type, and stable file bytes.
9. Addenda must remain separate immutable document records linked to the parent opportunity.
10. Bid-tab and award-result documents should be retained but classified as lifecycle/result records rather than solicitation response documents.

## Recommended ACAD acquisition profile

```json
{
  "publisher": "Northern Arizona University",
  "publisher_code": "AZ-NAU",
  "acquisition_method": "ACQ-008",
  "implementation_subtype": "DIRECT_SERVER_SIDE_HTTPS_STATIC_HTML",
  "authentication_required": false,
  "cookies_required": false,
  "javascript_rendering_required": false,
  "channels": [
    {
      "channel_code": "NAU-CENTRAL-BID-BOARD",
      "listing_url": "https://in.nau.edu/contracting-purchasing-services/nau-bid-board/",
      "opportunity_identity": "NAU:CPS:{SOLICITATION_NUMBER}"
    },
    {
      "channel_code": "NAU-FACILITIES-BIDS-RFQS",
      "listing_url": "https://in.nau.edu/facility-services/pdc/bids-rfqs/",
      "opportunity_identity": "NAU:PDC:{PROJECT_NUMBER}"
    }
  ],
  "document_acquisition_required": true,
  "acquire_all_project_scoped_links": true,
  "document_identity": "{OPPORTUNITY_ID}:{SOURCE_FILENAME}",
  "preserve_all_versions": true,
  "capture_actual_byte_count": true,
  "capture_last_modified": true,
  "capture_etag": true,
  "sha256_required": true,
  "verify_mime_type": true,
  "verify_pdf_signature": true,
  "lifecycle_rules": {
    "do_not_assume_open_from_page_presence": true,
    "do_not_infer_expiration_from_filename_year": true,
    "open_ended_language_overrides_missing_deadline": true,
    "award_or_ranked_firm_language_sets_awarded_or_evaluation_status": true,
    "past_due_date_sets_closed_unless_open_ended": true
  }
}
```

## Final determination

- **Publisher legitimacy:** Verified
- **Direct machine-to-machine access:** Verified
- **Complete attachment acquisition:** Verified
- **Addendum acquisition:** Verified
- **Active open-ended opportunity acquisition:** Verified
- **Recommended acquisition method:** `ACQ-008 — Static HTML Extraction`
- **Recommended connector complexity:** Moderate
- **Ready for ACAD connector engineering:** Yes
