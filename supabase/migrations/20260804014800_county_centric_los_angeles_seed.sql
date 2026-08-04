insert into public.county_expansion_profiles(
  state_code,county_name,county_fips,number_of_incorporated_cities,
  school_district_density,community_college_density,university_density,special_district_density,
  water_district_density,sanitation_district_density,transit_agency_density,housing_authority_density,
  utility_density,airport_presence,port_presence,public_hospital_presence,court_presence,
  library_system_presence,public_safety_entity_density,estimated_procurement_publisher_count_band,
  platform_diversity,engineering_reuse_potential,expansion_score,priority_tier,discovery_status,evidence,notes
) values (
  'CA','Los Angeles County','06037',88,
  'HIGH','HIGH','HIGH','VERY HIGH','VERY HIGH','HIGH','VERY HIGH','HIGH','HIGH','HIGH','HIGH','HIGH','HIGH','HIGH','HIGH',
  'VERY HIGH','HIGH','VERY HIGH',100,'TIER 1','READY',
  jsonb_build_object('source_document','APIE-CONTINUITY-BOOTSTRAP-001','validation_target',true),
  'Initial county-centric Publisher Discovery validation target.'
)
on conflict(state_code,county_key) do update set
  county_fips=excluded.county_fips,
  number_of_incorporated_cities=excluded.number_of_incorporated_cities,
  school_district_density=excluded.school_district_density,
  community_college_density=excluded.community_college_density,
  university_density=excluded.university_density,
  special_district_density=excluded.special_district_density,
  water_district_density=excluded.water_district_density,
  sanitation_district_density=excluded.sanitation_district_density,
  transit_agency_density=excluded.transit_agency_density,
  housing_authority_density=excluded.housing_authority_density,
  utility_density=excluded.utility_density,
  airport_presence=excluded.airport_presence,
  port_presence=excluded.port_presence,
  public_hospital_presence=excluded.public_hospital_presence,
  court_presence=excluded.court_presence,
  library_system_presence=excluded.library_system_presence,
  public_safety_entity_density=excluded.public_safety_entity_density,
  estimated_procurement_publisher_count_band=excluded.estimated_procurement_publisher_count_band,
  platform_diversity=excluded.platform_diversity,
  engineering_reuse_potential=excluded.engineering_reuse_potential,
  expansion_score=excluded.expansion_score,
  priority_tier=excluded.priority_tier,
  discovery_status=excluded.discovery_status,
  evidence=county_expansion_profiles.evidence||excluded.evidence,
  notes=excluded.notes,
  updated_at=now();

update public.publisher_registry
set configuration=configuration||jsonb_build_object(
  'county_name','Los Angeles County','county_fips','06037',
  'access_class','CLASS_A','platform_access_class','CLASS_A','machine_to_machine_supported',true,
  'recommended_connector_strategy','DIRECT_NETLIFY_CONNECTOR','connector_strategy','DIRECT_NETLIFY_CONNECTOR',
  'engineering_complexity','LOW','reuse_score',90,'connector_roi_score',95,
  'supports_search',true,'supports_pagination',true,'supports_detail_resolution',true,
  'supports_requirements',true,'supports_contacts',true,'supports_attachments',true,
  'supports_reconciliation',true,'supports_verification',true,
  'implementation_path','netlify/functions/_shared/acquisition-connectors.js'
)
where id='c87c5927-5e29-48ef-8a18-fd671ffac709'::uuid or publisher_name='County of Los Angeles';

update public.publisher_registry
set configuration=configuration||jsonb_build_object(
  'access_class','CLASS_B','platform_access_class','CLASS_B','machine_to_machine_supported',false,
  'stateful_session_required',true,'javascript_required',true,
  'recommended_connector_strategy','STATEFUL_SESSION_OR_HEADLESS_BROWSER',
  'connector_strategy','STATEFUL_SESSION_OR_HEADLESS_BROWSER',
  'engineering_complexity','VERY_HIGH','reuse_score',70,'connector_roi_score',40,
  'known_limitations',jsonb_build_array(
    'Inconsistent stateless machine responses','PeopleSoft session routing',
    'Dynamic event detail rendering','Possible anti-automation controls'
  )
)
where id='0cf29ac8-f55b-4b46-ac2f-93d75694a318'::uuid;

update public.publisher_registry set configuration=configuration;

update public.command_mission_types
set methodology=coalesce(methodology,'{}'::jsonb)||jsonb_build_object(
      'purpose','Discover and classify procurement publishers within one selected county',
      'geographic_scope','COUNTY','required_inputs',jsonb_build_array('STATE','COUNTY'),
      'platform_classification_required',true,'connector_recommendation_required',true
    ),
    methodology_version='3.0',
    registry_destination='publisher_registry,county_expansion_profiles,procurement_platform_registry,procurement_connector_registry',
    quality_control_requirements=coalesce(quality_control_requirements,'{}'::jsonb)||jsonb_build_object(
      'county_nexus_required',true,'official_source_required',true,
      'platform_access_class_required',true,'machine_to_machine_assessment_required',true
    ),
    updated_at=now()
where mission_type_key='PUBLISHER_DISCOVERY';
