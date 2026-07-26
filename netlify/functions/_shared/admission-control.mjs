export class AdmissionControlError extends Error {
  constructor(code, message, status = 409, details = {}) {
    super(message);
    this.name = 'AdmissionControlError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function requireSupabase(supabase) {
  if (!supabase || typeof supabase.from !== 'function') {
    throw new TypeError('A server-side Supabase client is required.');
  }
}

export async function getCurrentAdmittedContract(supabase, admittedContractId) {
  requireSupabase(supabase);
  if (!admittedContractId) {
    throw new AdmissionControlError('ADMITTED_CONTRACT_ID_REQUIRED', 'admitted_contract_id is required.', 400);
  }

  const { data, error } = await supabase
    .from('admitted_contracts_current')
    .select('*')
    .eq('admitted_contract_id', admittedContractId)
    .maybeSingle();

  if (error) {
    throw new AdmissionControlError('ADMISSION_LOOKUP_FAILED', 'Unable to verify contract admission.', 503, {
      databaseCode: error.code ?? null
    });
  }

  if (!data) {
    throw new AdmissionControlError('NOT_ADMITTED', 'The contract is not currently admitted.', 409);
  }

  return data;
}

export async function getAoieCandidate(supabase, admittedContractId) {
  requireSupabase(supabase);
  const { data, error } = await supabase
    .from('aoie_admitted_contract_candidates_v1')
    .select('*')
    .eq('admitted_contract_id', admittedContractId)
    .maybeSingle();

  if (error) {
    throw new AdmissionControlError('AOIE_ADMISSION_LOOKUP_FAILED', 'Unable to resolve an admitted AOIE candidate.', 503, {
      databaseCode: error.code ?? null
    });
  }
  if (!data) {
    throw new AdmissionControlError('NOT_ADMITTED', 'AOIE cannot process a non-admitted contract.', 409);
  }
  return data;
}

export async function getNatcorpDeliveryRecord(supabase, admittedContractId, businessProfileId = null) {
  requireSupabase(supabase);
  let query = supabase
    .from('apios_natcorp_delivery_current_v2')
    .select('*')
    .eq('admitted_contract_id', admittedContractId);

  if (businessProfileId) query = query.eq('business_profile_id', businessProfileId);

  const { data, error } = await query.maybeSingle();
  if (error) {
    throw new AdmissionControlError('DELIVERY_LOOKUP_FAILED', 'Unable to verify NAT-CORP delivery eligibility.', 503, {
      databaseCode: error.code ?? null
    });
  }
  if (!data) {
    throw new AdmissionControlError('DELIVERY_NOT_AUTHORIZED', 'The contract is not authorized for current NAT-CORP delivery.', 409);
  }
  return data;
}

export async function validateAnalyzeFitContract(supabase, admittedContractId) {
  const contract = await getCurrentAdmittedContract(supabase, admittedContractId);

  if (String(contract.lifecycle_status).toUpperCase() !== 'OPEN') {
    throw new AdmissionControlError('CONTRACT_NOT_OPEN', 'Analyze Fit requires an open admitted contract.', 409);
  }

  const deadline = new Date(contract.response_deadline);
  if (!Number.isFinite(deadline.valueOf()) || deadline <= new Date()) {
    throw new AdmissionControlError('CONTRACT_EXPIRED', 'Analyze Fit cannot process an expired contract.', 409);
  }

  if (!contract.contact_evidence_id) {
    throw new AdmissionControlError('CONTACT_EVIDENCE_INVALID', 'Verified contract-contact evidence is required.', 409);
  }
  if (!contract.scope_evidence_id) {
    throw new AdmissionControlError('SCOPE_EVIDENCE_INVALID', 'Verified scope evidence is required.', 409);
  }
  if (!Array.isArray(contract.requirements_evidence_manifest) && typeof contract.requirements_evidence_manifest !== 'object') {
    throw new AdmissionControlError('REQUIREMENTS_EVIDENCE_INVALID', 'Verified substantive requirements evidence is required.', 409);
  }

  return contract;
}

export function admissionErrorResponse(error) {
  const statusCode = error instanceof AdmissionControlError ? error.status : 500;
  return {
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      ok: false,
      error: error instanceof AdmissionControlError ? error.code : 'INTERNAL_ERROR',
      message: error instanceof AdmissionControlError ? error.message : 'An internal error occurred.'
    })
  };
}
